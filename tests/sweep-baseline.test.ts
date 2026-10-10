import { describe, expect, test } from 'claude-code/testing'

import type { Run } from '../hooks/git.ts'
import type { Exists } from '../hooks/paths.ts'
import { emptyQueue, loadQueue, saveQueue } from '../hooks/queue.ts'
import type { QueueIO } from '../hooks/queue.ts'
import { sweepRepos } from '../hooks/sweep.ts'
import { checkout, commit, detach, fakeGit, makeRepo, memoryFs } from './fake-git.ts'

const DATA = 'C:/data/.after-build-quiz'
const NOW = '2026-10-10T09:00:00.000Z'
const OLD = '2026-09-01T10:00:00Z'
const TOP = 'C:/work/foo'

const anywhere: Exists = async () => true
const deps = (run: Run, io: QueueIO) =>
  ({ run, io, exists: anywhere, dataDir: DATA, isWindows: true, minChangedLines: 10, queueCap: 10 })
const input = { sessionCwd: 'C:\\work\\foo', now: NOW }
const stored = async (io: QueueIO) => (await loadQueue(io, DATA, NOW)).queue

describe('sweepRepos: first sight is a baseline', () => {
  test('first sight of the session repo: HEAD recorded, nothing queued, no log', async () => {
    const repo = makeRepo(TOP)
    commit(repo, { committedAt: OLD })
    const head = commit(repo, { committedAt: '2026-10-09T10:00:00Z' })
    const fs = memoryFs()
    const git = fakeGit(repo)

    const outcome = await sweepRepos(deps(git.run, fs.io), input)

    expect(outcome.queued).toBe(0)
    const queue = await stored(fs.io)
    expect(queue.pending).toEqual([])
    expect(queue.lastSeen).toEqual({ [`${TOP}::main`]: head.hash })
    expect(git.calls.some(call => call[4] === 'log')).toBe(false)
  })

  test('first sight of a branch: older commits of mine on it are not queued', async () => {
    const repo = makeRepo(TOP)
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await saveQueue(fs.io, DATA, { ...emptyQueue(), lastSeen: { [`${TOP}::main`]: base.hash } })
    repo.branches.set('feature', base.hash)
    checkout(repo, 'feature')
    commit(repo, { committedAt: '2026-09-15T10:00:00Z' })
    const head = commit(repo, { committedAt: '2026-10-09T10:00:00Z' })

    await sweepRepos(deps(fakeGit(repo).run, fs.io), input)

    const queue = await stored(fs.io)
    expect(queue.pending).toEqual([])
    expect(queue.lastSeen).toEqual({ [`${TOP}::main`]: base.hash, [`${TOP}::feature`]: head.hash })
  })

  test('detached HEAD: baseline under ::HEAD', async () => {
    const repo = makeRepo(TOP)
    const head = commit(repo, { committedAt: OLD })
    detach(repo)
    const fs = memoryFs()

    await sweepRepos(deps(fakeGit(repo).run, fs.io), input)

    expect((await stored(fs.io)).lastSeen).toEqual({ [`${TOP}::HEAD`]: head.hash })
  })

  test('a repo with no commits yet is skipped: nothing written', async () => {
    const fs = memoryFs()

    const outcome = await sweepRepos(deps(fakeGit(makeRepo(TOP)).run, fs.io), input)

    expect(outcome.queued).toBe(0)
    expect(fs.writes).toEqual([])
  })

  test('HEAD equals lastSeen: no log, nothing queued, lastSeen unchanged', async () => {
    const repo = makeRepo(TOP)
    const head = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await saveQueue(fs.io, DATA, { ...emptyQueue(), lastSeen: { [`${TOP}::main`]: head.hash } })
    const git = fakeGit(repo)

    await sweepRepos(deps(git.run, fs.io), input)

    expect(git.calls.some(call => call[4] === 'log')).toBe(false)
    const queue = await stored(fs.io)
    expect(queue.pending).toEqual([])
    expect(queue.lastSeen).toEqual({ [`${TOP}::main`]: head.hash })
  })

  test('the session repo is marked as seen now', async () => {
    const repo = makeRepo(TOP)
    commit(repo, { committedAt: OLD })
    const fs = memoryFs()

    await sweepRepos(deps(fakeGit(repo).run, fs.io), input)

    expect((await stored(fs.io)).seenAt).toEqual({ [TOP]: NOW })
  })
})
