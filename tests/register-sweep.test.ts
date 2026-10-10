import { describe, expect, test } from 'claude-code/testing'

import { emptyQueue, saveQueue } from '../hooks/queue.ts'
import { commit, makeRepo } from './fake-git.ts'
import { DATA, OLD, pendingEntry, world } from './world.ts'

const START = { cwd: 'C:\\work\\foo', surface: 'terminal' as const, isInteractive: true }

describe('session.start sweep wiring', () => {
  test('status from the file first, git only after the timer, status updated after the sweep', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const base = commit(repo, { committedAt: OLD })
    const w = world(on, [repo])
    await saveQueue(w.fs.io, DATA, {
      ...emptyQueue(),
      pending: [pendingEntry('a'.repeat(40))],
      lastSeen: { 'C:/work/foo::main': base.hash },
    })
    commit(repo, { committedAt: '2026-10-09T10:00:00Z' }) // made in a terminal, outside Claude Code

    await $.session.start(START)

    expect(w.statuses).toEqual(['1 quiz pending'])
    expect(w.order.includes('git')).toBe(false)
    await w.settle()
    expect(w.order.includes('git')).toBe(true)
    expect(w.statuses.at(-1)).toBe('2 quizzes pending')
  })

  test('git errors go to the debug log only; nothing is thrown', async ($, on) => {
    const w = world(on, [makeRepo('C:/work/foo')])
    w.breakGit()

    await $.session.start(START)
    await w.settle()

    expect(w.logs.filter(log => log.to !== 'debug')).toEqual([])
  })

  test('a data folder inside a repo: the sweep writes nothing, one notice', async ($, on) => {
    const home = makeRepo('C:/Users/someone')
    const repo = makeRepo('C:/work/foo')
    commit(repo, { committedAt: OLD })
    const w = world(on, [home, repo])

    await $.session.start(START)
    await w.settle()

    expect(w.fs.writes).toEqual([])
    expect(w.logs.filter(log => log.to !== 'debug').length).toBe(1)
  })
})
