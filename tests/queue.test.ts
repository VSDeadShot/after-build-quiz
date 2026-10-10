import { describe, expect, test } from 'claude-code/testing'

import type { Run } from '../hooks/git.ts'
import type { Exists } from '../hooks/paths.ts'
import {
  COMMIT_FORMAT, emptyQueue, enqueue, loadQueue, parseCommitLine, saveQueue, selectNewest,
} from '../hooks/queue.ts'
import type { Queue, QueueEntry, QueueIO } from '../hooks/queue.ts'

const DATA = 'C:/data/.after-build-quiz'
const MAIN = `${DATA}/queue.json`
const TMP = `${DATA}/queue.json.tmp`
const NOW = '2026-10-10T08:30:00.000Z'

let counter = 0
const entry = (overrides: Partial<QueueEntry> = {}): QueueEntry => {
  counter++
  return {
    repo: 'C:/work/foo',
    repoName: 'foo',
    hash: `h${String(counter).padStart(39, '0')}`,
    parent: `p${String(counter).padStart(39, '0')}`,
    subject: `commit ${counter}`,
    committedAt: `2026-10-${String(counter % 28 + 1).padStart(2, '0')}T10:00:00+05:30`,
    queuedAt: NOW,
    source: 'claude-code',
    codeLines: 20,
    codeFiles: 2,
    ...overrides,
  }
}
const at = (day: number, time = '10:00:00') => `2026-09-${String(day).padStart(2, '0')}T${time}+05:30`
const opts = { isAmend: false, cap: 10, now: NOW }

// in-memory fs: records writes in order; paths can be made unreadable / unwritable
const memoryFs = (files: Record<string, string> = {}) => {
  const store = new Map(Object.entries(files))
  const writes: string[] = []
  const unreadable = new Set<string>()
  let isWriteBroken = false
  const io: QueueIO = {
    read: async path => {
      if (unreadable.has(path)) throw new Error('EIO: too large')
      const text = store.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    write: async (path, text) => {
      if (isWriteBroken) throw new Error('EACCES')
      writes.push(path)
      store.set(path, text)
    },
    exists: async path => store.has(path) || unreadable.has(path),
  }
  return {
    io, store, writes,
    makeUnreadable: (path: string) => unreadable.add(path),
    breakWrites: () => { isWriteBroken = true },
  }
}

const withSeq = (seq: number, pending: QueueEntry[] = []): Queue => ({ ...emptyQueue(), seq, pending })

describe('enqueue', () => {
  test('adds an entry', () => {
    const one = entry()
    expect(enqueue(emptyQueue(), one, opts).pending).toEqual([one])
  })

  test('a hash already pending is ignored', () => {
    const one = entry()
    const queue = enqueue(emptyQueue(), one, opts)
    expect(enqueue(queue, { ...one, subject: 'again' }, opts)).toEqual(queue)
  })

  test('the 11th entry evicts the oldest (by committedAt) into expired, reason cap', () => {
    let queue = emptyQueue()
    const entries = Array.from({ length: 11 }, (_, i) => entry({ committedAt: at(i + 1) }))
    for (const one of entries) queue = enqueue(queue, one, opts)
    expect(queue.pending.length).toBe(10)
    expect(queue.pending.map(e => e.hash)).not.toContain(entries[0]!.hash)
    expect(queue.expired).toEqual([{
      repo: entries[0]!.repo, repoName: 'foo', hash: entries[0]!.hash, subject: entries[0]!.subject,
      reason: 'cap', expiredAt: NOW,
    }])
    expect(queue.expiredCount).toBe(1)
  })

  test('an older commit queued late is sorted in place and is the one evicted', () => {
    let queue = emptyQueue()
    for (let day = 10; day < 20; day++) queue = enqueue(queue, entry({ committedAt: at(day) }), opts)
    const late = entry({ committedAt: at(2), source: 'sweep' })
    queue = enqueue(queue, late, opts)
    expect(queue.pending.length).toBe(10)
    expect(queue.expired[0]!.hash).toBe(late.hash)
  })

  test('pending stays sorted oldest → newest by committedAt, offsets respected', () => {
    let queue = emptyQueue()
    const later = entry({ committedAt: '2026-09-05T10:00:00+00:00' }) // 15:30 IST
    const earlier = entry({ committedAt: '2026-09-05T12:00:00+05:30' }) // 06:30 UTC
    queue = enqueue(queue, later, opts)
    queue = enqueue(queue, earlier, opts)
    expect(queue.pending.map(e => e.hash)).toEqual([earlier.hash, later.hash])
  })

  test('expired keeps the last 50; expiredCount keeps counting', () => {
    let queue = emptyQueue()
    for (let i = 0; i < 70; i++) {
      queue = enqueue(queue, entry({ committedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }), opts)
    }
    expect(queue.expiredCount).toBe(60)
    expect(queue.expired.length).toBe(50)
  })

  test('the cap comes from the setting', () => {
    let queue = emptyQueue()
    for (let day = 1; day <= 4; day++) queue = enqueue(queue, entry({ committedAt: at(day) }), { ...opts, cap: 3 })
    expect(queue.pending.length).toBe(3)
  })
})

describe('enqueue: --amend', () => {
  test('same repo + same parent + isAmend replaces the pending entry', () => {
    const original = entry({ parent: 'p'.repeat(40), committedAt: at(1) })
    const amended = entry({ parent: 'p'.repeat(40), committedAt: at(1, '10:05:00') })
    let queue = enqueue(emptyQueue(), original, opts)
    queue = enqueue(queue, amended, { ...opts, isAmend: true })
    expect(queue.pending).toEqual([amended])
    expect(queue.expired).toEqual([])
  })

  test('an amend of an amend replaces again', () => {
    const parent = 'q'.repeat(40)
    let queue = enqueue(emptyQueue(), entry({ parent }), opts)
    queue = enqueue(queue, entry({ parent }), { ...opts, isAmend: true })
    const third = entry({ parent })
    queue = enqueue(queue, third, { ...opts, isAmend: true })
    expect(queue.pending).toEqual([third])
  })

  test('same parent in a different repo is added', () => {
    const parent = 'r'.repeat(40)
    let queue = enqueue(emptyQueue(), entry({ parent }), opts)
    queue = enqueue(queue, entry({ parent, repo: 'C:/work/bar', repoName: 'bar' }), { ...opts, isAmend: true })
    expect(queue.pending.length).toBe(2)
  })

  test('same parent without isAmend (sibling branches) is added', () => {
    const parent = 's'.repeat(40)
    let queue = enqueue(emptyQueue(), entry({ parent }), opts)
    queue = enqueue(queue, entry({ parent }), opts)
    expect(queue.pending.length).toBe(2)
  })

  test('a root commit (no parent) is never treated as replacing another', () => {
    let queue = enqueue(emptyQueue(), entry({ parent: null }), opts)
    queue = enqueue(queue, entry({ parent: null }), { ...opts, isAmend: true })
    expect(queue.pending.length).toBe(2)
  })
})

describe('parseCommitLine: committer date, not author date', () => {
  test('the format asks for %cI', () => {
    expect(COMMIT_FORMAT).toContain('%cI')
  })

  test('committedAt is the committer date', () => {
    const line = ['a'.repeat(40), 'b'.repeat(40), '2020-01-01T09:00:00+05:30', '2026-10-09T20:00:00+05:30', 'Fix it'].join('\x1f')
    expect(parseCommitLine(`${line}\n`)).toEqual({
      hash: 'a'.repeat(40), parents: ['b'.repeat(40)], authoredAt: '2020-01-01T09:00:00+05:30',
      committedAt: '2026-10-09T20:00:00+05:30', subject: 'Fix it',
    })
  })

  test('an old author date with a new committer date sorts as newest', () => {
    const line = ['c'.repeat(40), 'd'.repeat(40), '2020-01-01T09:00:00+05:30', '2026-10-09T20:00:00+05:30', 'Rebased'].join('\x1f')
    const parsed = parseCommitLine(line)!
    let queue = enqueue(emptyQueue(), entry({ committedAt: '2026-10-01T10:00:00+05:30' }), opts)
    queue = enqueue(queue, entry({ hash: parsed.hash, committedAt: parsed.committedAt }), opts)
    expect(queue.pending.at(-1)!.hash).toBe(parsed.hash)
  })

  test('root and merge commits, and junk', () => {
    const root = ['e'.repeat(40), '', '2026-10-09T20:00:00Z', '2026-10-09T20:00:00Z', 'init'].join('\x1f')
    expect(parseCommitLine(root)?.parents).toEqual([])
    const merge = ['f'.repeat(40), `${'1'.repeat(40)} ${'2'.repeat(40)}`, '2026-10-09T20:00:00Z', '2026-10-09T20:00:00Z', 'merge'].join('\x1f')
    expect(parseCommitLine(merge)?.parents.length).toBe(2)
    expect(parseCommitLine('not a commit line')).toBeUndefined()
  })
})

describe('selectNewest', () => {
  const recordingCheck = (missing: Set<string> = new Set(), goneRepos: Set<string> = new Set()) => {
    const calls: (readonly string[])[] = []
    const run: Run = async argv => {
      calls.push(argv)
      const isMissing = [...missing].some(hash => argv.at(-1) === `${hash}^{commit}`)
      return { exitCode: isMissing ? 128 : 0, stdout: '', stderr: isMissing ? 'fatal: Not a valid object name' : '', isStdoutTruncated: false, isStderrTruncated: false }
    }
    const exists: Exists = async path => !goneRepos.has(path)
    return { check: { run, exists }, calls }
  }
  const twoQueued = () => {
    const older = entry({ committedAt: at(1) })
    const newer = entry({ committedAt: at(2) })
    return { older, newer, queue: enqueue(enqueue(emptyQueue(), older, opts), newer, opts) }
  }

  test('returns the newest pending entry and asks git exactly once, through git.ts', async () => {
    const { newer, queue } = twoQueued()
    const { check, calls } = recordingCheck()
    const picked = await selectNewest(queue, check, NOW)
    expect(picked.entry).toEqual(newer)
    expect(calls).toEqual([['git', '-C', newer.repo, '--no-pager', 'cat-file', '-e', `${newer.hash}^{commit}`]])
  })

  test('selecting does not remove: a skipped quiz is still pending next time', async () => {
    const { newer, queue } = twoQueued()
    const { check } = recordingCheck()
    const first = await selectNewest(queue, check, NOW)
    const second = await selectNewest(first.queue, check, NOW)
    expect(second.entry).toEqual(newer)
    expect(second.queue.pending.length).toBe(2)
  })

  test('a missing commit moves to expired (missing) and the next newest is returned', async () => {
    const { older, newer, queue } = twoQueued()
    const { check } = recordingCheck(new Set([newer.hash]))
    const picked = await selectNewest(queue, check, NOW)
    expect(picked.entry).toEqual(older)
    expect(picked.queue.pending).toEqual([older])
    expect(picked.queue.expired).toEqual([{
      repo: newer.repo, repoName: newer.repoName, hash: newer.hash, subject: newer.subject,
      reason: 'missing', detail: 'commit not found', expiredAt: NOW,
    }])
    expect(picked.queue.expiredCount).toBe(1)
  })

  test('a repo folder that is gone expires its entries without running git', async () => {
    const { older, newer, queue } = twoQueued()
    const { check, calls } = recordingCheck(new Set(), new Set([newer.repo]))
    const picked = await selectNewest(queue, check, NOW)
    expect(picked.entry).toBeUndefined()
    expect(picked.queue.expired.map(e => e.detail)).toEqual(['repo folder not found', 'repo folder not found'])
    expect(picked.queue.pending).toEqual([])
    expect(calls).toEqual([])
    void older
  })

  test('when everything is missing, nothing is returned', async () => {
    const { older, newer, queue } = twoQueued()
    const { check } = recordingCheck(new Set([older.hash, newer.hash]))
    const picked = await selectNewest(queue, check, NOW)
    expect(picked.entry).toBeUndefined()
    expect(picked.queue.pending).toEqual([])
  })

  test('if git cannot run, the entry is kept and returned (never expired on uncertainty)', async () => {
    const { newer, queue } = twoQueued()
    const run: Run = async () => { throw new Error('spawn git ENOENT') }
    const picked = await selectNewest(queue, { run, exists: async () => true }, NOW)
    expect(picked.entry).toEqual(newer)
    expect(picked.queue.pending.length).toBe(2)
    expect(picked.queue.expired).toEqual([])
  })

  test('an empty queue returns nothing', async () => {
    const { check } = recordingCheck()
    expect((await selectNewest(emptyQueue(), check, NOW)).entry).toBeUndefined()
  })
})

describe('loadQueue / saveQueue', () => {
  test('no file: an empty queue, no notice, writable', async () => {
    const { io } = memoryFs()
    expect(await loadQueue(io, DATA, NOW)).toEqual({ queue: emptyQueue(), isWritable: true })
  })

  test('save then load round-trips, and every save increments seq', async () => {
    const { io } = memoryFs()
    const first = await saveQueue(io, DATA, enqueue(emptyQueue(), entry(), opts))
    expect(first.isSaved).toBe(true)
    expect(first.queue.seq).toBe(1)
    const second = await saveQueue(io, DATA, first.queue)
    expect(second.queue.seq).toBe(2)
    expect((await loadQueue(io, DATA, NOW)).queue).toEqual(second.queue)
  })

  test('save writes the tmp copy first, then queue.json, both under dataDir only', async () => {
    const { io, writes } = memoryFs()
    await saveQueue(io, DATA, emptyQueue())
    expect(writes).toEqual([TMP, MAIN])
  })

  test('crash mid-write: queue.json half-written, tmp complete → recovered from tmp', async () => {
    const saved = withSeq(4, [entry()])
    const text = JSON.stringify(saved)
    const { io } = memoryFs({ [TMP]: text, [MAIN]: text.slice(0, 40) })
    const loaded = await loadQueue(io, DATA, NOW)
    expect(loaded.queue).toEqual(saved)
    expect(loaded.notice).toBeUndefined()
  })

  test('both valid: the higher seq wins (tmp N+1 over queue.json N)', async () => {
    const older = withSeq(7, [entry()])
    const newer = withSeq(8, [entry(), entry()])
    const { io } = memoryFs({ [MAIN]: JSON.stringify(older), [TMP]: JSON.stringify(newer) })
    expect((await loadQueue(io, DATA, NOW)).queue).toEqual(newer)
  })

  test('both valid: queue.json wins when its seq is higher', async () => {
    const stale = withSeq(3)
    const current = withSeq(4, [entry()])
    const { io } = memoryFs({ [MAIN]: JSON.stringify(current), [TMP]: JSON.stringify(stale) })
    expect((await loadQueue(io, DATA, NOW)).queue).toEqual(current)
  })

  test('corrupt queue.json (no valid tmp): copied aside verbatim, fresh queue, one-line notice', async () => {
    const garbage = '{"version":1,"pending":[ oops'
    const { io, store } = memoryFs({ [MAIN]: garbage })
    const loaded = await loadQueue(io, DATA, NOW)
    const aside = `${DATA}/queue.corrupt-2026-10-10T08-30-00-000Z.json`
    expect(store.get(aside)).toBe(garbage)
    expect(loaded.queue).toEqual(emptyQueue())
    expect(loaded.isWritable).toBe(true)
    expect(loaded.notice).toContain('queue.corrupt-2026-10-10T08-30-00-000Z.json')
    expect(loaded.notice!.includes('\n')).toBe(false)
  })

  test('valid JSON with the wrong shape counts as corrupt', async () => {
    const { io } = memoryFs({ [MAIN]: JSON.stringify({ version: 1, seq: 'two', pending: 'nope' }) })
    const loaded = await loadQueue(io, DATA, NOW)
    expect(loaded.queue).toEqual(emptyQueue())
    expect(loaded.notice).toBeDefined()
  })

  test('an unreadable queue.json: empty queue, notice, not writable (never overwritten)', async () => {
    const { io, makeUnreadable, writes } = memoryFs()
    makeUnreadable(MAIN)
    const loaded = await loadQueue(io, DATA, NOW)
    expect(loaded.queue).toEqual(emptyQueue())
    expect(loaded.isWritable).toBe(false)
    expect(loaded.notice).toBeDefined()
    expect(writes).toEqual([])
  })

  test('a failing write: saveQueue reports false and does not throw', async () => {
    const { io, breakWrites } = memoryFs()
    breakWrites()
    const result = await saveQueue(io, DATA, emptyQueue())
    expect(result.isSaved).toBe(false)
    expect(result.queue.seq).toBe(0)
  })

  test('lastSeen is carried through untouched', async () => {
    const { io } = memoryFs()
    const queue = { ...emptyQueue(), lastSeen: { 'C:/work/foo': 'a'.repeat(40) } }
    const saved = await saveQueue(io, DATA, queue)
    expect((await loadQueue(io, DATA, NOW)).queue.lastSeen).toEqual(saved.queue.lastSeen)
  })
})
