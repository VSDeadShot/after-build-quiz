// Test helper (not a test file): the world beneath the plugin for wiring tests
// through the test kit — fake git, an in-memory data folder, a mock clock, the
// session cwd, and recorders for the tool, status line and logs.
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { emptyQueue, saveQueue } from '../hooks/queue.ts'
import type { QueueEntry } from '../hooks/queue.ts'
import { fakeGit, memoryFs } from './fake-git.ts'
import type { FakeRepo } from './fake-git.ts'

export const STARTED = Date.parse('2026-10-10T08:30:00Z')
export const DATA = 'C:/Users/someone/.after-build-quiz'
export const QUEUE = `${DATA}/queue.json`
export const OLD = '2026-09-01T10:00:00Z'
export const OK = { stdout: 'ok', stderr: '', interrupted: false }
const DIRS = new Set(['C:/', 'C:/Users', 'C:/Users/someone', 'C:/work', 'C:/work/foo', 'C:/work/bar'])

// the engine hands fs hooks the platform spelling (backslashes on Windows)
const slash = (path: string) => path.replace(/\\/g, '/')

export const pendingEntry = (hash: string): QueueEntry => ({
  repo: 'C:/work/foo', repoName: 'foo', hash, parent: null, subject: 's', committedAt: OLD,
  queuedAt: OLD, source: 'claude-code', codeLines: 20, codeFiles: 1,
})

export const world = (on: On, repos: FakeRepo[], options: { sessionCwd?: string; onTool?: () => void } = {}) => {
  const git = fakeGit(...repos)
  const fs = memoryFs()
  const order: string[] = []
  const statuses: (string | undefined)[] = []
  const logs: { text: string; to: string }[] = []
  let toolRuns = 0
  let isGitBroken = false
  let isCwdBroken = false

  mock.env(on, { USERPROFILE: 'C:\\Users\\someone' })
  const clock = mock.clock(on, { now: STARTED })
  on('session.cwd', () => {
    if (isCwdBroken) throw new Error('cwd unavailable')
    return { value: options.sessionCwd ?? 'C:\\work\\foo' }
  })
  on('process.run', async ($, e) => {
    order.push('git')
    if (isGitBroken) throw new Error('spawn git ENOENT')
    return { value: await git.run(e.argv, e.init) }
  })
  on('fs.exists', async ($, e) => { order.push('fs'); return { value: DIRS.has(slash(e.path)) || (await fs.io.exists(slash(e.path))) } })
  on('fs.read', async ($, e) => { order.push('fs'); return { value: await fs.io.read(slash(e.path)) } })
  on('fs.write', async ($, e) => { order.push('fs'); await fs.io.write(slash(e.path), e.text); return { value: undefined } })
  on('ui.status', ($, e) => { statuses.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { logs.push({ text: e.text, to: e.to }); return { value: undefined } })
  on('tool.call', () => {
    toolRuns++
    order.push('tool')
    options.onTool?.()
    return { result: OK }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.CwdChanged', () => ({}))

  const settle = async () => {
    await clock.advance(0)
    await clock.settle()
  }
  return {
    git, fs, order, statuses, logs, clock, settle,
    toolRuns: () => toolRuns,
    breakGit: () => { isGitBroken = true },
    breakCwd: () => { isCwdBroken = true },
  }
}

export const seenRepo = async (fs: ReturnType<typeof memoryFs>, top: string, sha: string) =>
  saveQueue(fs.io, DATA, { ...emptyQueue(), lastSeen: { [`${top}::main`]: sha } })
