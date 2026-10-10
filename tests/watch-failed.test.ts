import { describe, expect, test } from 'claude-code/testing'

import { detectCommits, parseCommit } from '../hooks/detect.ts'
import type { Run } from '../hooks/git.ts'
import { emptyQueue, loadQueue, saveQueue } from '../hooks/queue.ts'
import type { QueueIO } from '../hooks/queue.ts'
import { commit, fakeGit, makeRepo, memoryFs } from './fake-git.ts'

const DATA = 'C:/data/.after-build-quiz'
const STARTED = Date.parse('2026-10-10T08:30:00Z')
const NOW = '2026-10-10T08:30:10.000Z'
const OLD = '2026-09-01T10:00:00Z'
const TOP = 'C:/work/foo'
const MAIN_KEY = `${TOP}::main`

const deps = (run: Run, io: QueueIO) => ({ run, io, dataDir: DATA, isWindows: true, minChangedLines: 10, queueCap: 10 })
const input = (cmd: string) => ({
  command: parseCommit(cmd)!, trackedCwd: undefined, sessionCwd: 'C:\\work\\foo', startedAt: STARTED, now: NOW,
})
const seen = (io: QueueIO, lastSeen: Record<string, string>) => saveQueue(io, DATA, { ...emptyQueue(), lastSeen })
const stored = async (io: QueueIO) => (await loadQueue(io, DATA, NOW)).queue

describe('detectCommits: a commit that did not happen', () => {
  test('HEAD unchanged (failed commit): nothing queued, one git call, nothing written', async () => {
    const repo = makeRepo(TOP)
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await seen(fs.io, { [MAIN_KEY]: base.hash })
    fs.writes.length = 0
    const git = fakeGit(repo)

    const outcome = await detectCommits(deps(git.run, fs.io), input('git commit -m "rejected by hook"'))

    expect(outcome.queued).toBe(0)
    expect(git.calls.length).toBe(1)
    expect(fs.writes).toEqual([])
  })

  test('first sight of a repo, failed commit: nothing queued, baseline recorded', async () => {
    const repo = makeRepo(TOP)
    const old = commit(repo, { committedAt: OLD })
    const fs = memoryFs()

    const outcome = await detectCommits(deps(fakeGit(repo).run, fs.io), input('git commit -m nothing-staged'))

    expect(outcome.queued).toBe(0)
    const queue = await stored(fs.io)
    expect(queue.pending).toEqual([])
    expect(queue.lastSeen[MAIN_KEY]).toBe(old.hash)
  })

  test('first sight of a repo, successful commit: only that commit is queued (--since window)', async () => {
    const repo = makeRepo(TOP)
    commit(repo, { committedAt: OLD })
    const made = commit(repo, { committedAt: '2026-10-10T08:30:05Z' })
    const fs = memoryFs()
    const git = fakeGit(repo)

    await detectCommits(deps(git.run, fs.io), input('git commit -m first-seen'))

    expect((await stored(fs.io)).pending.map(e => e.hash)).toEqual([made.hash])
    const log = git.calls.find(call => call[4] === 'log')!
    expect(log).toContain('--since=2026-10-10T08:29:59Z')
  })

  test('no commits yet (unborn HEAD): nothing happens', async () => {
    const repo = makeRepo(TOP)
    const fs = memoryFs()

    const outcome = await detectCommits(deps(fakeGit(repo).run, fs.io), input('git commit -m first'))

    expect(outcome.queued).toBe(0)
    expect(fs.writes).toEqual([])
  })

  test('a pruned lastSeen falls back to the --since window', async () => {
    const repo = makeRepo(TOP)
    commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await seen(fs.io, { [MAIN_KEY]: 'f'.repeat(40) })
    const made = commit(repo, { committedAt: '2026-10-10T08:30:05Z' })

    await detectCommits(deps(fakeGit(repo).run, fs.io), input('git commit -m after-gc'))

    expect((await stored(fs.io)).pending.map(e => e.hash)).toEqual([made.hash])
  })

  test('no user.email configured: no author filter', async () => {
    const repo = makeRepo(TOP, null)
    const base = commit(repo, { committedAt: OLD, email: 'someone@example.com' })
    const fs = memoryFs()
    await seen(fs.io, { [MAIN_KEY]: base.hash })
    const made = commit(repo, { email: 'someone@example.com' })
    const git = fakeGit(repo)

    await detectCommits(deps(git.run, fs.io), input('git commit -m x'))

    expect((await stored(fs.io)).pending.map(e => e.hash)).toEqual([made.hash])
    expect(git.calls.find(call => call[4] === 'log')!.some(arg => arg.startsWith('--author'))).toBe(false)
  })
})
