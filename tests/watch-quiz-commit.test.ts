import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { ActiveQuiz } from '../hooks/active.ts'
import { emptyQueue, saveQueue } from '../hooks/queue.ts'
import type { Queue, QueueEntry } from '../hooks/queue.ts'
import { commit, makeRepo } from './fake-git.ts'
import { ACTIVE, fileText, HASH, quizOf } from './quiz-fixture.ts'
import { DATA, OLD, pendingEntry, QUEUE, world } from './world.ts'

type World = ReturnType<typeof world>

const START = { cwd: 'C:\\work\\foo', surface: 'terminal', isInteractive: true } as const
const PAUSED = quizOf({ isPaused: true, pausedAt: OLD })

// `count` pending commits in C:/work/foo, one a day from 2026-09-01; the oldest is the quiz's commit (HASH).
const pendingOf = (count: number): QueueEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    ...pendingEntry(index === 0 ? HASH : String(index).repeat(40)),
    committedAt: `2026-09-${String(index + 1).padStart(2, '0')}T10:00:00Z`,
  }))
const SECOND_OLDEST = '1'.repeat(40)

// a repo whose last seen commit is `base`; the queue holds `count` pending and that sighting
const setUp = async (w: World, repo: ReturnType<typeof makeRepo>, count: number, quiz: ActiveQuiz | null | undefined) => {
  const base = commit(repo, { committedAt: OLD })
  await saveQueue(w.fs.io, DATA, { ...emptyQueue(), pending: pendingOf(count), lastSeen: { 'C:/work/foo::main': base.hash } })
  if (quiz !== undefined) w.fs.store.set(ACTIVE, fileText(quiz))
}
const queueOf = (w: World): Queue => JSON.parse(w.fs.store.get(QUEUE)!)
const commitWithBash = async ($: Engine, w: World) => {
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Add a"' })
  await w.settle()
}
const activePaths = (paths: string[]) => paths.filter(path => path.includes('/active'))

describe('the cap never evicts the commit of the quiz in progress', () => {
  for (const [name, quiz] of [
    ['a paused quiz', PAUSED],
    ["this session's running quiz", quizOf()],
    ["another session's running quiz", quizOf({ sessionId: 'another-session' })],
  ] as const) {
    test(`${name}, a full queue, one more commit through the Bash tool: the next-oldest expires instead`, async ($, on) => {
      const repo = makeRepo('C:/work/foo')
      const w = world(on, [repo], { onTool: () => { commit(repo) } })
      await setUp(w, repo, 10, quiz)

      await commitWithBash($, w)

      const queue = queueOf(w)
      expect(queue.pending.length).toBe(10)
      expect(queue.pending[0]!.hash).toBe(HASH)
      expect(queue.expired.map(e => [e.hash, e.reason])).toEqual([[SECOND_OLDEST, 'cap']])
    })
  }

  test('the same through the session-start sweep (a commit made outside Claude Code)', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const w = world(on, [repo])
    await setUp(w, repo, 10, PAUSED)
    commit(repo)

    await $.session.start(START)
    await w.settle()

    const queue = queueOf(w)
    expect(queue.pending.length).toBe(10)
    expect(queue.pending[0]!.hash).toBe(HASH)
    expect(queue.expired.map(e => [e.hash, e.reason])).toEqual([[SECOND_OLDEST, 'cap']])
  })

  test('the quiz in active.json is never written by this: byte-identical afterwards', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const w = world(on, [repo], { onTool: () => { commit(repo) } })
    await setUp(w, repo, 10, PAUSED)

    await commitWithBash($, w)

    expect(w.fs.store.get(ACTIVE)).toBe(fileText(PAUSED))
    expect(activePaths(w.fs.writes)).toEqual([])
  })
})

describe('without a quiz to protect, the cap works as before', () => {
  for (const [name, quiz] of [
    ['no active.json', undefined],
    ['an active.json with no quiz', null],
    ['a quiz on another commit', quizOf({ commit: { ...quizOf().commit, hash: 'd'.repeat(40) } })],
    ['a quiz on the same hash in another repo', quizOf({ commit: { ...quizOf().commit, repo: 'C:/work/bar' } })],
  ] as const) {
    test(`${name}: the oldest pending commit expires`, async ($, on) => {
      const repo = makeRepo('C:/work/foo')
      const w = world(on, [repo], { onTool: () => { commit(repo) } })
      await setUp(w, repo, 10, quiz)

      await commitWithBash($, w)

      const queue = queueOf(w)
      expect(queue.pending.length).toBe(10)
      expect(queue.expired.map(e => [e.hash, e.reason])).toEqual([[HASH, 'cap']])
    })
  }

  test('corrupt active.json: the commit is still queued, nothing is copied aside, written or shown', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const w = world(on, [repo], { onTool: () => { commit(repo) } })
    await setUp(w, repo, 10, undefined)
    w.fs.store.set(ACTIVE, '{ broken')

    await commitWithBash($, w)

    expect(queueOf(w).pending.length).toBe(10)
    expect(queueOf(w).expired.map(e => e.hash)).toEqual([HASH])
    expect(w.fs.store.get(ACTIVE)).toBe('{ broken')
    expect(activePaths([...w.fs.store.keys()])).toEqual([ACTIVE])
    expect(w.logs.filter(log => log.to !== 'debug')).toEqual([])
  })

  test('unreadable active.json: the commit is still queued, nothing is written beside the queue', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const w = world(on, [repo], { onTool: () => { commit(repo) } })
    await setUp(w, repo, 10, PAUSED)
    w.fs.makeUnreadable(ACTIVE)

    await commitWithBash($, w)

    expect(queueOf(w).pending.length).toBe(10)
    expect(queueOf(w).expired.map(e => e.hash)).toEqual([HASH])
    expect(activePaths(w.fs.writes)).toEqual([])
    expect(w.logs.filter(log => log.to !== 'debug')).toEqual([])
  })
})

describe('active.json is read only when the cap could evict', () => {
  test('a queue below the cap: a commit is queued without touching active.json', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const w = world(on, [repo], { onTool: () => { commit(repo) } })
    await setUp(w, repo, 3, PAUSED)

    await commitWithBash($, w)

    expect(queueOf(w).pending.length).toBe(4)
    expect(activePaths(w.touched)).toEqual([])
  })

  test('a full queue: active.json is read (and its .tmp), never written', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const w = world(on, [repo], { onTool: () => { commit(repo) } })
    await setUp(w, repo, 10, PAUSED)

    await commitWithBash($, w)

    expect(activePaths(w.touched).length > 0).toBe(true)
    expect(activePaths(w.fs.writes)).toEqual([])
  })

  test('a command that is not a commit still touches no file', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const w = world(on, [repo])
    await setUp(w, repo, 10, PAUSED)

    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await w.settle()

    expect(w.touched).toEqual([])
  })
})
