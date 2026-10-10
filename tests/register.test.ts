import { describe, expect, test } from 'claude-code/testing'

import { emptyQueue, saveQueue } from '../hooks/queue.ts'
import type { QueueEntry } from '../hooks/queue.ts'
import { commit, makeRepo } from './fake-git.ts'
import { DATA, OK, OLD, pendingEntry, QUEUE, seenRepo, world } from './world.ts'

describe('tool.call wiring', () => {
  for (const tool of ['Bash', 'PowerShell'] as const) {
    test(`${tool}: the result comes back unchanged, and git runs only after the tool and the timer`, async ($, on) => {
      const repo = makeRepo('C:/work/foo')
      const base = commit(repo, { committedAt: OLD })
      const w = world(on, [repo], { onTool: () => { commit(repo) } })
      await seenRepo(w.fs, 'C:/work/foo', base.hash)

      const ran = await $.tool.call({ tool, command: 'git add src/a.ts && git commit -m "Add a"' })

      expect(ran.result).toEqual(OK)
      expect(w.order.includes('git')).toBe(false)
      expect(w.order.indexOf('tool') >= 0).toBe(true)
      await w.settle()
      expect(w.order.indexOf('git') > w.order.indexOf('tool')).toBe(true)
      expect(w.statuses.at(-1)).toBe('1 quiz pending')
    })
  }

  test('a non-commit command: no git, no file access', async ($, on) => {
    const w = world(on, [makeRepo('C:/work/foo')])
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await w.settle()
    expect(w.order).toEqual(['tool'])
  })

  test('run_in_background: no detection', async ($, on) => {
    const w = world(on, [makeRepo('C:/work/foo')])
    await $.tool.call({ tool: 'Bash', command: 'git commit -m x', run_in_background: true })
    await w.settle()
    expect(w.order).toEqual(['tool'])
  })

  test('git throwing: the result is still unchanged and nothing is thrown', async ($, on) => {
    const w = world(on, [makeRepo('C:/work/foo')])
    w.breakGit()
    const ran = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
    await w.settle()
    expect(ran.result).toEqual(OK)
    expect(w.logs.filter(log => log.to !== 'debug')).toEqual([])
  })

  test('a hook failure before the command passes the call through, once', async ($, on) => {
    const w = world(on, [makeRepo('C:/work/foo')])
    w.breakCwd()
    const ran = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
    expect(ran.result).toEqual(OK)
    expect(w.toolRuns()).toBe(1)
  })

  test('CwdChanged: the tracked directory is used', async ($, on) => {
    const bar = makeRepo('C:/work/bar')
    const base = commit(bar, { committedAt: OLD })
    const w = world(on, [bar], { sessionCwd: 'C:\\elsewhere', onTool: () => { commit(bar) } })
    await seenRepo(w.fs, 'C:/work/bar', base.hash)

    await $.classic.CwdChanged({ old_cwd: 'C:\\elsewhere', new_cwd: 'C:\\work\\bar' })
    await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
    await w.settle()

    const queue = JSON.parse(w.fs.store.get(QUEUE)!)
    expect(queue.pending.map((e: QueueEntry) => e.repo)).toEqual(['C:/work/bar'])
  })

  test('a corrupt queue: exactly one transcript notice across two commits', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    commit(repo, { committedAt: OLD })
    const w = world(on, [repo], { onTool: () => { commit(repo) } })
    w.fs.store.set(QUEUE, '{ broken')

    await $.tool.call({ tool: 'Bash', command: 'git commit -m one' })
    await w.settle()
    w.fs.store.set(QUEUE, '{ broken again')
    await $.tool.call({ tool: 'Bash', command: 'git commit -m two' })
    await w.settle()

    expect(w.logs.filter(log => log.to !== 'debug').length).toBe(1)
  })

  test('a data folder inside a repo: nothing written, one notice', async ($, on) => {
    const home = makeRepo('C:/Users/someone')
    const repo = makeRepo('C:/work/foo')
    commit(repo, { committedAt: OLD })
    const w = world(on, [home, repo], { onTool: () => { commit(repo) } })

    await $.tool.call({ tool: 'Bash', command: 'git commit -m one' })
    await w.settle()
    await $.tool.call({ tool: 'Bash', command: 'git commit -m two' })
    await w.settle()

    expect(w.fs.writes).toEqual([])
    expect(w.logs.filter(log => log.to !== 'debug').length).toBe(1)
  })
})

describe('status line', () => {
  test('session start reads the queue file only: 2 pending, zero git calls', async ($, on) => {
    const w = world(on, [])
    await saveQueue(w.fs.io, DATA, { ...emptyQueue(), pending: [pendingEntry('a'.repeat(40)), pendingEntry('b'.repeat(40))] })

    await $.session.start({ cwd: 'C:\\work\\foo', surface: 'terminal', isInteractive: true })

    expect(w.statuses).toEqual(['2 quizzes pending'])
    expect(w.order.includes('git')).toBe(false)
  })

  test('session start with nothing pending clears the status', async ($, on) => {
    const w = world(on, [])

    await $.session.start({ cwd: 'C:\\work\\foo', surface: 'terminal', isInteractive: true })

    expect(w.statuses).toEqual([undefined])
    expect(w.order.includes('git')).toBe(false)
  })
})
