import { describe, expect, test } from 'claude-code/testing'

import type { DetectDeps } from '../hooks/detect.ts'
import type { Run } from '../hooks/git.ts'
import { safeDataDirOf } from '../hooks/paths.ts'
import type { Exists } from '../hooks/paths.ts'
import {
  COMMIT_FORMAT, completeCommit, emptyQueue, enqueue, expireUngrounded, loadQueue, markSkipped, parseCommitLine, peekQueue,
  saveQueue, selectNext, updateQueue,
} from '../hooks/queue.ts'
import type { Queue, QueueEntry, QueueIO } from '../hooks/queue.ts'
import type { SweepDeps } from '../hooks/sweep.ts'

const DATA = safeDataDirOf('C:/data/.after-build-quiz', { isSafe: true })
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

  test('a missing commit counts under missing (3f2)', async () => {
    const { newer, queue } = twoQueued()
    const { check } = recordingCheck(new Set([newer.hash]))
    const picked = await selectNext(queue, check, NOW)
    expect(picked.queue.expiredByReason).toEqual({ cap: 0, missing: 1, ungrounded: 0 })
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

  test('a queue file from before seenAt loads with an empty one: valid, writable, nothing copied aside', async () => {
    const saved = withSeq(5, [entry()])
    const old: Partial<Queue> = { ...saved }
    delete old.seenAt
    const { io, store, writes } = memoryFs({ [MAIN]: JSON.stringify(old) })
    expect('seenAt' in JSON.parse(store.get(MAIN)!)).toBe(false)

    expect(await loadQueue(io, DATA, NOW)).toEqual({ queue: { ...saved, seenAt: {} }, isWritable: true })
    expect(await peekQueue(io, DATA)).toEqual({ queue: { ...saved, seenAt: {} }, isWritable: true })
    expect(writes).toEqual([])
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

  const UNREADABLE = 'after-build-quiz: could not read queue.json (Error: EIO: too large); using an empty queue and not overwriting it this session'

  test('an unreadable queue.json is not replaced by a valid .tmp copy: empty queue, not writable, the notice', async () => {
    const text = JSON.stringify(withSeq(6, [entry(), entry()]))
    const { io, makeUnreadable, writes, store } = memoryFs({ [TMP]: text })
    makeUnreadable(MAIN)

    const loaded = await loadQueue(io, DATA, NOW)

    expect(loaded).toEqual({ queue: emptyQueue(), isWritable: false, notice: UNREADABLE })
    expect(writes).toEqual([])
    expect(store.get(TMP)).toBe(text)
  })

  test('the same on a read-only load (the status line): the .tmp copy is not shown either', async () => {
    const { io, makeUnreadable, writes } = memoryFs({ [TMP]: JSON.stringify(withSeq(6, [entry(), entry()])) })
    makeUnreadable(MAIN)

    const loaded = await peekQueue(io, DATA)

    expect(loaded).toEqual({ queue: emptyQueue(), isWritable: false, notice: UNREADABLE })
    expect(writes).toEqual([])
  })

  test('an unreadable .tmp beside a good queue.json: queue.json is used, writable, no notice', async () => {
    const saved = withSeq(6, [entry(), entry()])
    const { io, makeUnreadable } = memoryFs({ [MAIN]: JSON.stringify(saved) })
    makeUnreadable(TMP)
    expect(await loadQueue(io, DATA, NOW)).toEqual({ queue: saved, isWritable: true })
  })

  test('a corrupt .tmp beside a good queue.json: queue.json is used, nothing is copied aside', async () => {
    const saved = withSeq(6, [entry()])
    const { io, writes } = memoryFs({ [MAIN]: JSON.stringify(saved), [TMP]: '{ broken' })
    expect(await loadQueue(io, DATA, NOW)).toEqual({ queue: saved, isWritable: true })
    expect(writes).toEqual([])
  })

  test('a failing write: saveQueue reports false and does not throw', async () => {
    const { io, breakWrites } = memoryFs()
    breakWrites()
    const result = await saveQueue(io, DATA, emptyQueue())
    expect(result.isSaved).toBe(false)
    expect(result.queue.seq).toBe(0)
  })

  // 3f1: as saveActive, a queue that would not load back is never written; the good file on disk stays.
  test('a queue that would not load back is not written: not saved, nothing written, the file on disk kept', async () => {
    const good = withSeq(3, [entry()])
    const goodText = JSON.stringify(good)
    const broken: [string, Queue][] = [
      ['an entry with no committedAt', { ...good, pending: [{ ...entry(), committedAt: undefined } as unknown as QueueEntry] }],
      ['a lastSeen that is not a string', { ...good, lastSeen: { 'C:/work/foo::main': 7 } as unknown as Record<string, string> }],
      ['a seq that is not a whole number', { ...good, seq: 2.5 }],
      ['a skipped mark that is not a string', { ...good, pending: [{ ...entry(), skippedAt: 5 } as unknown as QueueEntry] }],
    ]
    for (const [name, queue] of broken) {
      const { io, writes, store } = memoryFs({ [MAIN]: goodText })
      const result = await saveQueue(io, DATA, queue)
      expect([name, result.isSaved, writes, store.get(MAIN) === goodText]).toEqual([name, false, [], true])
      expect([name, result.queue]).toEqual([name, queue])
      expect([name, (await loadQueue(io, DATA, NOW)).queue]).toEqual([name, good])
    }
  })

  test('every queue the transforms build is still written and loads back', async () => {
    const one = entry()
    const queues = [
      emptyQueue(),
      enqueue(emptyQueue(), one, opts),
      markSkipped(enqueue(emptyQueue(), one, opts), { repo: one.repo, hash: one.hash }, NOW),
      Array.from({ length: 12 }, () => entry()).reduce((queue, next) => enqueue(queue, next, opts), emptyQueue()),
    ]
    for (const queue of queues) {
      const { io } = memoryFs()
      const saved = await saveQueue(io, DATA, queue)
      expect(saved.isSaved).toBe(true)
      expect((await loadQueue(io, DATA, NOW)).queue).toEqual(saved.queue)
    }
  })

  test('lastSeen is carried through untouched', async () => {
    const { io } = memoryFs()
    const queue = { ...emptyQueue(), lastSeen: { 'C:/work/foo': 'a'.repeat(40) } }
    const saved = await saveQueue(io, DATA, queue)
    expect((await loadQueue(io, DATA, NOW)).queue.lastSeen).toEqual(saved.queue.lastSeen)
  })

  test('only a checked data folder is accepted for writes (type-level: tsc checks these directives)', () => {
    const unchecked = (io: QueueIO, run: Run, exists: Exists) => {
      // @ts-expect-error a plain string is not a SafeDataDir
      void saveQueue(io, 'C:/data', emptyQueue())
      // @ts-expect-error a plain string is not a SafeDataDir
      void loadQueue(io, 'C:/data', NOW)
      void peekQueue(io, 'C:/data') // reading only: a plain path is fine
      const detect: DetectDeps = {
        run, io, isWindows: true, minChangedLines: 10, queueCap: 10,
        // @ts-expect-error a plain string is not a SafeDataDir
        dataDir: 'C:/data',
      }
      const sweep: SweepDeps = {
        run, io, exists, isWindows: true, minChangedLines: 10, queueCap: 10,
        // @ts-expect-error a plain string is not a SafeDataDir
        dataDir: 'C:/data',
      }
      // @ts-expect-error a plain string is not a SafeDataDir
      void updateQueue(io, 'C:/data', NOW, queue => queue)
      return [detect, sweep]
    }
    expect(typeof unchecked).toBe('function')
  })
})

describe('completeCommit: a finished quiz leaves pending (3f2)', () => {
  const two = () => {
    const a = entry({ committedAt: at(1) })
    const b = entry({ committedAt: at(2) })
    return { a, b, queue: enqueue(enqueue(emptyQueue(), a, opts), b, opts) }
  }

  test('removes only that commit; expired and every count stay as they are', () => {
    const { a, b, queue } = two()
    const done = completeCommit(queue, { repo: a.repo, hash: a.hash })
    expect(done.pending).toEqual([b])
    expect([done.expired, done.expiredCount, done.expiredByReason]).toEqual([[], 0, { cap: 0, missing: 0, ungrounded: 0 }])
  })

  test('another commit keeps its skipped mark', () => {
    const { a, b, queue } = two()
    const skipped = markSkipped(queue, { repo: b.repo, hash: b.hash }, NOW)
    expect(completeCommit(skipped, { repo: a.repo, hash: a.hash }).pending).toEqual([{ ...b, skippedAt: NOW }])
  })

  test('a commit that is not pending (amended away, already gone, another repo) gives back the same queue', () => {
    const { a, queue } = two()
    expect(completeCommit(queue, { repo: a.repo, hash: 'f'.repeat(40) })).toBe(queue)
    expect(completeCommit(queue, { repo: 'C:/work/bar', hash: a.hash })).toBe(queue)
  })
})

describe('expireUngrounded (3f2)', () => {
  test('moves the commit to expired with reason ungrounded and its detail; the total and ungrounded count go up', () => {
    const a = entry({ committedAt: at(1) })
    const b = entry({ committedAt: at(2) })
    const queue = enqueue(enqueue(emptyQueue(), a, opts), b, opts)
    const out = expireUngrounded(queue, { repo: a.repo, hash: a.hash }, NOW, 'no question cited a diff line')
    expect(out.pending).toEqual([b])
    expect(out.expired).toEqual([{
      repo: a.repo, repoName: a.repoName, hash: a.hash, subject: a.subject,
      reason: 'ungrounded', detail: 'no question cited a diff line', expiredAt: NOW,
    }])
    expect([out.expiredCount, out.expiredByReason]).toEqual([1, { cap: 0, missing: 0, ungrounded: 1 }])
  })

  test('a commit that is not pending gives back the same queue', () => {
    const queue = enqueue(emptyQueue(), entry(), opts)
    expect(expireUngrounded(queue, { repo: 'C:/work/foo', hash: 'f'.repeat(40) }, NOW)).toBe(queue)
  })

  test('past the last 50 kept, the total and the per-reason count keep counting', () => {
    const entries = Array.from({ length: 55 }, () => entry())
    let queue: Queue = withSeq(0, entries)
    for (const one of entries) queue = expireUngrounded(queue, { repo: one.repo, hash: one.hash }, NOW)
    expect([queue.pending.length, queue.expired.length, queue.expiredCount, queue.expiredByReason])
      .toEqual([0, 50, 55, { cap: 0, missing: 0, ungrounded: 55 }])
  })
})

describe('expired counts per reason (3f2)', () => {
  const ASIDE = `${DATA}/queue.corrupt-2026-10-10T08-30-00-000Z.json`
  const expiredRow = (reason: string) => ({
    repo: 'C:/work/foo', repoName: 'foo', hash: 'e'.repeat(40), subject: 'gone', reason, expiredAt: NOW,
  })

  test('a cap eviction counts under cap', () => {
    const queue = Array.from({ length: 12 }, () => entry()).reduce((sum, one) => enqueue(sum, one, opts), emptyQueue())
    expect([queue.expiredCount, queue.expiredByReason]).toEqual([2, { cap: 2, missing: 0, ungrounded: 0 }])
  })

  test('a queue file from before per-reason counts loads with counts from its kept entries: valid, writable, nothing copied aside', async () => {
    const saved = withSeq(4, [entry()])
    const kept = [expiredRow('cap'), expiredRow('cap'), expiredRow('missing')]
    const old: Partial<Queue> = { ...saved, expired: kept as Queue['expired'], expiredCount: 60 }
    delete old.expiredByReason
    const { io, store, writes } = memoryFs({ [MAIN]: JSON.stringify(old) })
    expect('expiredByReason' in JSON.parse(store.get(MAIN)!)).toBe(false)

    const expected = { ...old, expiredByReason: { cap: 2, missing: 1, ungrounded: 0 } }
    expect(await loadQueue(io, DATA, NOW)).toEqual({ queue: expected, isWritable: true })
    expect(await peekQueue(io, DATA)).toEqual({ queue: expected, isWritable: true })
    expect(writes).toEqual([])
  })

  test('per-reason counts that are not a whole number of at least 0 for every reason count as corrupt', async () => {
    const bad: [string, unknown][] = [
      ['a reason left out', { cap: 0, missing: 0 }],
      ['a negative count', { cap: -1, missing: 0, ungrounded: 0 }],
      ['a fraction', { cap: 0, missing: 0.5, ungrounded: 0 }],
      ['not an object', 3],
    ]
    for (const [name, counts] of bad) {
      const { io, store } = memoryFs({ [MAIN]: JSON.stringify({ ...withSeq(4, [entry()]), expiredByReason: counts }) })
      const loaded = await loadQueue(io, DATA, NOW)
      expect([name, loaded.queue, store.has(ASIDE)]).toEqual([name, emptyQueue(), true])
    }
  })
})

describe('updateQueue: load, change, save (3f2)', () => {
  test('a change is saved with the next seq, and the saved queue comes back', async () => {
    const one = entry()
    const { io, writes } = memoryFs({ [MAIN]: JSON.stringify(withSeq(4, [one])) })
    const updated = await updateQueue(io, DATA, NOW, queue => completeCommit(queue, { repo: one.repo, hash: one.hash }))
    expect([updated.isChanged, updated.isSaved, updated.queue.seq, updated.queue.pending]).toEqual([true, true, 5, []])
    expect(writes).toEqual([TMP, MAIN])
    expect((await loadQueue(io, DATA, NOW)).queue).toEqual(updated.queue)
  })

  test('a change that gives back the same queue writes nothing', async () => {
    const saved = withSeq(4, [entry()])
    const { io, writes } = memoryFs({ [MAIN]: JSON.stringify(saved) })
    expect(await updateQueue(io, DATA, NOW, queue => queue)).toEqual({ queue: saved, isChanged: false, isSaved: false })
    expect(writes).toEqual([])
  })

  test('an unreadable queue.json is not written, even with a valid .tmp copy; the notice comes back', async () => {
    const { io, makeUnreadable, writes } = memoryFs({ [TMP]: JSON.stringify(withSeq(6, [entry()])) })
    makeUnreadable(MAIN)
    const updated = await updateQueue(io, DATA, NOW, queue => ({ ...queue, lastSeen: { 'C:/work/foo::main': 'a'.repeat(40) } }))
    expect([updated.queue, updated.isChanged, updated.isSaved, writes]).toEqual([emptyQueue(), false, false, []])
    expect(updated.notice).toContain('could not read queue.json')
  })

  test('a change that throws: nothing written, nothing thrown, the queue as it is on disk', async () => {
    const saved = withSeq(4, [entry()])
    const { io, writes } = memoryFs({ [MAIN]: JSON.stringify(saved) })
    const updated = await updateQueue(io, DATA, NOW, () => { throw new Error('boom') })
    expect([updated, writes]).toEqual([{ queue: saved, isChanged: false, isSaved: false }, []])
  })

  test('a failed save reports the queue as it is on disk', async () => {
    const one = entry()
    const saved = withSeq(4, [one])
    const { io, breakWrites } = memoryFs({ [MAIN]: JSON.stringify(saved) })
    breakWrites()
    const updated = await updateQueue(io, DATA, NOW, queue => completeCommit(queue, { repo: one.repo, hash: one.hash }))
    expect(updated).toEqual({ queue: saved, isChanged: true, isSaved: false })
  })

  test('a corrupt queue.json is copied aside first; the change applies to a fresh queue, with the notice', async () => {
    const { io, store } = memoryFs({ [MAIN]: '{ broken' })
    const updated = await updateQueue(io, DATA, NOW, queue => ({ ...queue, lastSeen: { 'C:/work/foo::main': 'a'.repeat(40) } }))
    expect([updated.isChanged, updated.isSaved, updated.queue.seq]).toEqual([true, true, 1])
    expect(store.get(`${DATA}/queue.corrupt-2026-10-10T08-30-00-000Z.json`)).toBe('{ broken')
    expect(updated.notice).toContain('was corrupt')
  })

  test('a file system that fails every call never throws', async () => {
    const broken: QueueIO = {
      read: async () => { throw new Error('EIO') },
      write: async () => { throw new Error('EIO') },
      exists: async () => { throw new Error('EIO') },
    }
    const updated = await updateQueue(broken, DATA, NOW, queue => ({ ...queue, seq: queue.seq }))
    expect([updated.isChanged, updated.isSaved]).toEqual([false, false])
  })
})
