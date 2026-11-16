import { describe, expect, test } from 'claude-code/testing'
import type { PromptSubmitInput } from 'claude-code'

import { emptyQueue, saveQueue } from '../hooks/queue.ts'
import type { Queue } from '../hooks/queue.ts'
import { commit, makeRepo } from './fake-git.ts'
import { ACTIVE, ACTIVE_TMP, fileText, quizOf } from './quiz-fixture.ts'
import { DATA, OLD, pendingEntry, QUEUE, world } from './world.ts'

type World = ReturnType<typeof world>

const QUEUE_TMP = `${QUEUE}.tmp`
const START = { cwd: 'C:\\work\\foo', surface: 'terminal', isInteractive: true } as const
const shown = (w: World) => w.logs.filter(log => log.to !== 'debug').map(log => log.text)
const queueWrites = (w: World) => w.fs.writes.filter(path => path.includes('/queue'))

// A queue with `count` pending commits and the repo's base commit as last seen, saved (both copies);
// then queue.json can no longer be read, while its .tmp copy is whole.
const unreadableQueue = async (w: World, repo: ReturnType<typeof makeRepo>, count: number) => {
  const base = commit(repo, { committedAt: OLD })
  await saveQueue(w.fs.io, DATA, {
    ...emptyQueue(),
    pending: Array.from({ length: count }, (_, index) => pendingEntry(String(index).repeat(40))),
    lastSeen: { 'C:/work/foo::main': base.hash },
  })
  w.fs.makeUnreadable(QUEUE)
  return { seeded: queueWrites(w).length, tmp: w.fs.store.get(QUEUE_TMP)! }
}

describe('an unreadable queue.json is never used or overwritten, even with a valid .tmp copy', () => {
  test('a commit through the Bash tool: nothing queued, neither queue file written, one notice, no count shown', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const w = world(on, [repo], { onTool: () => { commit(repo) } })
    const { seeded, tmp } = await unreadableQueue(w, repo, 2)

    await $.tool.call({ tool: 'Bash', command: 'git commit -m "Add a"' })
    await w.settle()

    expect(queueWrites(w).length).toBe(seeded)
    expect(w.fs.store.get(QUEUE_TMP)).toBe(tmp)
    // the reason in brackets is the engine's wording for the failed read, not ours
    expect(shown(w).length).toBe(1)
    expect(shown(w)[0]!.startsWith('after-build-quiz: could not read queue.json (')).toBe(true)
    expect(shown(w)[0]!.endsWith('); using an empty queue and not overwriting it this session')).toBe(true)
    expect(w.statuses).toEqual([])
  })

  test('session start: the .tmp count is not shown, the sweep writes nothing, one notice in all', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const w = world(on, [repo])
    const { seeded, tmp } = await unreadableQueue(w, repo, 2)
    commit(repo)

    await $.session.start(START)
    await w.settle()

    expect(w.statuses).toEqual([undefined])
    expect(queueWrites(w).length).toBe(seeded)
    expect(w.fs.store.get(QUEUE_TMP)).toBe(tmp)
    expect(shown(w).length).toBe(1)
  })

  test('once queue.json reads again, the next commit queues the missed commit too', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const w = world(on, [repo], { onTool: () => { commit(repo) } })
    await unreadableQueue(w, repo, 1)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "missed"' })
    await w.settle()

    w.fs.makeReadable(QUEUE)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "seen"' })
    await w.settle()

    const queue: Queue = JSON.parse(w.fs.store.get(QUEUE)!)
    expect(queue.pending.length).toBe(3)
    expect(w.statuses.at(-1)).toBe('3 quizzes pending')
  })

  test('a running quiz is still paused by a prompt: only active.json is written, and the status shows no count', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const w = world(on, [repo])
    const { seeded, tmp } = await unreadableQueue(w, repo, 2)
    w.fs.store.set(ACTIVE, fileText(quizOf()))
    await $.session.start(START)
    await w.settle()
    const sent: PromptSubmitInput = { text: 'fix the login bug', wait: false, origin: { kind: 'composer' } }

    const entered = await $.prompt.submit(sent)
    await w.settle()

    expect(entered).toEqual({ text: 'fix the login bug' })
    expect(JSON.parse(w.fs.store.get(ACTIVE)!).quiz.isPaused).toBe(true)
    expect(w.fs.writes.filter(path => !path.includes('/queue'))).toEqual([ACTIVE_TMP, ACTIVE])
    expect(queueWrites(w).length).toBe(seeded)
    expect(w.fs.store.get(QUEUE_TMP)).toBe(tmp)
    expect(w.statuses.at(-1)).toBe('quiz paused · /quiz to resume')
    expect(shown(w).length).toBe(1)
  })
})

describe('the rule covers queue.json itself, not its .tmp copy', () => {
  test('an unreadable .tmp beside a good queue.json: the commit is queued as usual', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const base = commit(repo, { committedAt: OLD })
    const w = world(on, [repo], { onTool: () => { commit(repo) } })
    // not 'a' × 40: the fake repo's tenth commit has exactly that hash
    await saveQueue(w.fs.io, DATA, { ...emptyQueue(), pending: [pendingEntry('7'.repeat(40))], lastSeen: { 'C:/work/foo::main': base.hash } })
    w.fs.makeUnreadable(QUEUE_TMP)

    await $.tool.call({ tool: 'Bash', command: 'git commit -m "Add a"' })
    await w.settle()

    expect(w.statuses.at(-1)).toBe('2 quizzes pending')
    expect(shown(w)).toEqual([])
  })
})
