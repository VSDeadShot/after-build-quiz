import { describe, expect, test } from 'claude-code/testing'

import type { Run } from '../hooks/git.ts'
import type { Exists } from '../hooks/paths.ts'
import {
  COMMIT_FORMAT, emptyQueue, enqueue, loadQueue, markSkipped, parseCommitLine, saveQueue, selectNext,
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

describe("enqueue: the commit of the quiz in progress is never evicted by the cap", () => {
  // ten pending, days 1–10, oldest first
  const full = () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry({ committedAt: at(i + 1) }))
    let queue = emptyQueue()
    for (const one of entries) queue = enqueue(queue, one, opts)
    return { entries, queue }
  }
  const refOf = (one: QueueEntry) => ({ repo: one.repo, hash: one.hash })

  test('the quiz commit is the oldest: the next-oldest is evicted instead, and the cap holds', () => {
    const { entries, queue } = full()
    const next = enqueue(queue, entry({ committedAt: at(11) }), { ...opts, keep: refOf(entries[0]!) })
    expect(next.pending.length).toBe(10)
    expect(next.pending[0]).toEqual(entries[0])
    expect(next.pending.map(e => e.hash)).not.toContain(entries[1]!.hash)
    expect(next.expired).toEqual([{
      repo: entries[1]!.repo, repoName: 'foo', hash: entries[1]!.hash, subject: entries[1]!.subject,
      reason: 'cap', expiredAt: NOW,
    }])
  })

  test('the quiz commit is not the oldest: the oldest is evicted as usual', () => {
    const { entries, queue } = full()
    const next = enqueue(queue, entry({ committedAt: at(11) }), { ...opts, keep: refOf(entries[5]!) })
    expect(next.expired.map(e => e.hash)).toEqual([entries[0]!.hash])
    expect(next.pending.map(e => e.hash)).toContain(entries[5]!.hash)
  })

  test('cap 1 with the quiz commit pending: the new commit is the one that expires', () => {
    const quiz = entry({ committedAt: at(1) })
    const queue = enqueue(emptyQueue(), quiz, { ...opts, cap: 1 })
    const arrived = entry({ committedAt: at(2) })
    const next = enqueue(queue, arrived, { ...opts, cap: 1, keep: refOf(quiz) })
    expect(next.pending).toEqual([quiz])
    expect(next.expired.map(e => e.hash)).toEqual([arrived.hash])
  })

  test('a cap lowered by several: evicts down to the cap, oldest first, around the kept commit', () => {
    const entries = Array.from({ length: 6 }, (_, i) => entry({ committedAt: at(i + 1) }))
    let queue = emptyQueue()
    for (const one of entries) queue = enqueue(queue, one, opts)
    const arrived = entry({ committedAt: at(7) })
    const next = enqueue(queue, arrived, { ...opts, cap: 3, keep: refOf(entries[0]!) })
    expect(next.pending.map(e => e.hash)).toEqual([entries[0]!.hash, entries[5]!.hash, arrived.hash])
    expect(next.expired.map(e => e.hash)).toEqual(entries.slice(1, 5).map(e => e.hash))
  })

  test('an older commit queued late while the quiz commit is the oldest pending: the late one is evicted', () => {
    const { entries, queue } = full()
    const late = entry({ committedAt: '2026-08-01T10:00:00+05:30', source: 'sweep' })
    const kept = entry({ committedAt: '2026-08-02T10:00:00+05:30' })
    const withQuiz = enqueue({ ...queue, pending: queue.pending.slice(1) }, kept, opts)
    const next = enqueue(withQuiz, late, { ...opts, keep: refOf(kept) })
    expect(next.expired.map(e => e.hash)).toEqual([late.hash])
    expect(next.pending[0]).toEqual(kept)
    void entries
  })

  test('the same hash in another repo is not the quiz commit', () => {
    const { entries, queue } = full()
    const next = enqueue(queue, entry({ committedAt: at(11) }), { ...opts, keep: { repo: 'C:/work/bar', hash: entries[0]!.hash } })
    expect(next.expired.map(e => e.hash)).toEqual([entries[0]!.hash])
  })

  test('a kept commit that is not pending changes nothing', () => {
    const { entries, queue } = full()
    const next = enqueue(queue, entry({ committedAt: at(11) }), { ...opts, keep: { repo: 'C:/work/foo', hash: 'f'.repeat(40) } })
    expect(next.expired.map(e => e.hash)).toEqual([entries[0]!.hash])
  })

  test('an amend of the quiz commit replaces its pending entry as usual; nothing is expired', () => {
    const quiz = entry({ committedAt: at(1) })
    const queue = enqueue(emptyQueue(), quiz, opts)
    const amended = entry({ parent: quiz.parent, committedAt: at(2) })
    const next = enqueue(queue, amended, { ...opts, isAmend: true, keep: refOf(quiz) })
    expect(next.pending).toEqual([amended])
    expect(next.expired).toEqual([])
  })
})

describe('markSkipped', () => {
  const LATER = '2026-10-11T09:00:00.000Z'
  const three = () => {
    const entries = [entry({ committedAt: at(1) }), entry({ committedAt: at(2) }), entry({ committedAt: at(3) })]
    let queue = emptyQueue()
    for (const one of entries) queue = enqueue(queue, one, opts)
    return { entries, queue }
  }

  test('marks that pending entry with the time, and nothing else', () => {
    const { entries, queue } = three()
    const next = markSkipped(queue, { repo: entries[1]!.repo, hash: entries[1]!.hash }, NOW)
    expect(next).toEqual({ ...queue, pending: [entries[0], { ...entries[1], skippedAt: NOW }, entries[2]] })
  })

  test('skipping it again records the later time', () => {
    const { entries, queue } = three()
    const ref = { repo: entries[1]!.repo, hash: entries[1]!.hash }
    const next = markSkipped(markSkipped(queue, ref, NOW), ref, LATER)
    expect(next.pending[1]!.skippedAt).toBe(LATER)
  })

  test('a commit that is not pending changes nothing', () => {
    const { queue } = three()
    expect(markSkipped(queue, { repo: 'C:/work/foo', hash: 'f'.repeat(40) }, NOW)).toBe(queue)
  })

  test('the same hash in another repo changes nothing', () => {
    const { entries, queue } = three()
    expect(markSkipped(queue, { repo: 'C:/work/bar', hash: entries[1]!.hash }, NOW)).toBe(queue)
  })

  test('the queue it was given is not changed', () => {
    const { entries, queue } = three()
    const before = JSON.stringify(queue)
    markSkipped(queue, { repo: entries[1]!.repo, hash: entries[1]!.hash }, NOW)
    expect(JSON.stringify(queue)).toBe(before)
  })

  test('an amend that replaces a skipped commit queues the new one unskipped', () => {
    const { entries, queue } = three()
    const skipped = markSkipped(queue, { repo: entries[2]!.repo, hash: entries[2]!.hash }, NOW)
    const amended = entry({ parent: entries[2]!.parent, committedAt: at(4) })
    const next = enqueue(skipped, amended, { ...opts, isAmend: true })
    expect(next.pending.at(-1)).toEqual(amended)
    expect(next.pending.some(e => e.skippedAt !== undefined)).toBe(false)
  })

  test('the cap ignores the mark: the oldest commit is evicted, skipped or not', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry({ committedAt: at(i + 1) }))
    let queue = emptyQueue()
    for (const one of entries) queue = enqueue(queue, one, opts)
    queue = markSkipped(queue, { repo: entries[9]!.repo, hash: entries[9]!.hash }, NOW)
    const next = enqueue(queue, entry({ committedAt: at(11) }), opts)
    expect(next.expired.map(e => e.hash)).toEqual([entries[0]!.hash])
    expect(next.pending.find(e => e.hash === entries[9]!.hash)!.skippedAt).toBe(NOW)
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

describe('selectNext', () => {
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
    const picked = await selectNext(queue, check, NOW)
    expect(picked.entry).toEqual(newer)
    expect(calls).toEqual([['git', '-C', newer.repo, '--no-pager', 'cat-file', '-e', `${newer.hash}^{commit}`]])
  })

  test('selecting does not remove: a skipped quiz is still pending next time', async () => {
    const { newer, queue } = twoQueued()
    const { check } = recordingCheck()
    const first = await selectNext(queue, check, NOW)
    const second = await selectNext(first.queue, check, NOW)
    expect(second.entry).toEqual(newer)
    expect(second.queue.pending.length).toBe(2)
  })

  test('a missing commit moves to expired (missing) and the next newest is returned', async () => {
    const { older, newer, queue } = twoQueued()
    const { check } = recordingCheck(new Set([newer.hash]))
    const picked = await selectNext(queue, check, NOW)
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
    const picked = await selectNext(queue, check, NOW)
    expect(picked.entry).toBeUndefined()
    expect(picked.queue.expired.map(e => e.detail)).toEqual(['repo folder not found', 'repo folder not found'])
    expect(picked.queue.pending).toEqual([])
    expect(calls).toEqual([])
    void older
  })

  test('when everything is missing, nothing is returned', async () => {
    const { older, newer, queue } = twoQueued()
    const { check } = recordingCheck(new Set([older.hash, newer.hash]))
    const picked = await selectNext(queue, check, NOW)
    expect(picked.entry).toBeUndefined()
    expect(picked.queue.pending).toEqual([])
  })

  test('if git cannot run, the entry is kept and returned (never expired on uncertainty)', async () => {
    const { newer, queue } = twoQueued()
    const run: Run = async () => { throw new Error('spawn git ENOENT') }
    const picked = await selectNext(queue, { run, exists: async () => true }, NOW)
    expect(picked.entry).toEqual(newer)
    expect(picked.queue.pending.length).toBe(2)
    expect(picked.queue.expired).toEqual([])
  })

  test('an empty queue returns nothing', async () => {
    const { check } = recordingCheck()
    expect((await selectNext(emptyQueue(), check, NOW)).entry).toBeUndefined()
  })
})

describe('selectNext: skipped commits rank behind unskipped ones', () => {
  const checkOf = (missing: string[] = []) => {
    const calls: string[] = []
    const run: Run = async argv => {
      const hash = String(argv.at(-1)).replace('^{commit}', '')
      calls.push(hash)
      const isMissing = missing.includes(hash)
      return { exitCode: isMissing ? 128 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    }
    return { check: { run, exists: (async () => true) as Exists }, calls }
  }
  const T1 = '2026-10-11T09:00:00.000Z'
  const T2 = '2026-10-12T09:00:00.000Z'
  const T3 = '2026-10-13T09:00:00.000Z'
  // three pending, days 1–3; `skips` maps a day to when it was skipped
  const queued = (skips: Record<number, string> = {}) => {
    const entries = [1, 2, 3].map(day => entry({ committedAt: at(day) }))
    let queue = emptyQueue()
    for (const one of entries) queue = enqueue(queue, one, opts)
    for (const [day, when] of Object.entries(skips)) {
      const one = entries[Number(day) - 1]!
      queue = markSkipped(queue, { repo: one.repo, hash: one.hash }, when)
    }
    const [day1, day2, day3] = queue.pending as [QueueEntry, QueueEntry, QueueEntry]
    return { queue, day1, day2, day3 }
  }

  test('an unskipped commit is picked over a newer skipped one', async () => {
    const { queue, day2 } = queued({ 3: T1 })
    expect((await selectNext(queue, checkOf().check, NOW)).entry).toEqual(day2)
  })

  test('among unskipped commits the newest is still picked', async () => {
    const { queue, day3 } = queued({ 1: T1 })
    expect((await selectNext(queue, checkOf().check, NOW)).entry).toEqual(day3)
  })

  test('only skipped ones left: the one skipped longest ago is picked, whatever its commit date', async () => {
    const { queue, day2 } = queued({ 1: T2, 2: T1, 3: T3 })
    expect((await selectNext(queue, checkOf().check, NOW)).entry).toEqual(day2)
  })

  test('skipped at the same moment: the newest commit is picked', async () => {
    const { queue, day3 } = queued({ 1: T1, 2: T1, 3: T1 })
    expect((await selectNext(queue, checkOf().check, NOW)).entry).toEqual(day3)
  })

  test('skipping the picked one again moves it behind the other skipped ones', async () => {
    const { queue, day1, day2 } = queued({ 1: T2, 2: T1, 3: T3 })
    const again = markSkipped(queue, { repo: day2.repo, hash: day2.hash }, '2026-10-14T09:00:00.000Z')
    expect((await selectNext(again, checkOf().check, NOW)).entry).toEqual(day1)
  })

  test('the whole order is asked of git in turn: unskipped newest first, then skipped oldest-skip first', async () => {
    const { queue, day1, day2, day3 } = queued({ 1: T2, 3: T1 })
    const { check, calls } = checkOf([day1.hash, day2.hash, day3.hash])
    const picked = await selectNext(queue, check, NOW)
    expect(picked.entry).toBeUndefined()
    expect(calls).toEqual([day2.hash, day3.hash, day1.hash])
    expect(picked.queue.expired.map(e => e.hash)).toEqual([day2.hash, day3.hash, day1.hash])
  })

  test('a missing unskipped commit expires and the first skipped one is returned, still marked', async () => {
    const { queue, day2, day3 } = queued({ 3: T1, 1: T2 })
    const picked = await selectNext(queue, checkOf([day2.hash]).check, NOW)
    expect(picked.entry).toEqual(day3)
    expect(picked.entry!.skippedAt).toBe(T1)
    expect(picked.queue.pending.length).toBe(2)
  })

  test('if git cannot run, the first in pick order is kept and returned', async () => {
    const { queue, day2 } = queued({ 3: T1 })
    const run: Run = async () => { throw new Error('spawn git ENOENT') }
    const picked = await selectNext(queue, { run, exists: async () => true }, NOW)
    expect(picked.entry).toEqual(day2)
    expect(picked.queue.expired).toEqual([])
  })

  test('selecting changes neither the marks nor the stored order', async () => {
    const { queue } = queued({ 2: T1 })
    const picked = await selectNext(queue, checkOf().check, NOW)
    expect(picked.queue).toEqual(queue)
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

  test('a skipped mark survives a save and a load', async () => {
    const { io } = memoryFs()
    const one = entry()
    const skipped = markSkipped(enqueue(emptyQueue(), one, opts), { repo: one.repo, hash: one.hash }, NOW)
    const saved = await saveQueue(io, DATA, skipped)
    const loaded = await loadQueue(io, DATA, NOW)
    expect(loaded.queue).toEqual(saved.queue)
    expect(loaded.queue.pending[0]!.skippedAt).toBe(NOW)
  })

  test('a queue file from before the skipped mark loads as it is', async () => {
    const saved = withSeq(4, [entry(), entry()])
    const { io } = memoryFs({ [MAIN]: JSON.stringify(saved) })
    const loaded = await loadQueue(io, DATA, NOW)
    expect(loaded.queue).toEqual(saved)
    expect(loaded.notice).toBeUndefined()
  })

  test('a skipped mark that is not a string counts as corrupt', async () => {
    const saved = withSeq(4, [{ ...entry(), skippedAt: 5 } as unknown as QueueEntry])
    const { io, store } = memoryFs({ [MAIN]: JSON.stringify(saved) })
    const loaded = await loadQueue(io, DATA, NOW)
    expect(loaded.queue).toEqual(emptyQueue())
    expect(store.has(`${DATA}/queue.corrupt-2026-10-10T08-30-00-000Z.json`)).toBe(true)
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
