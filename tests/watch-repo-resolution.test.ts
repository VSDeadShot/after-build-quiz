import { describe, expect, test } from 'claude-code/testing'

import { detectCommits, parseCommit } from '../hooks/detect.ts'
import type { Run } from '../hooks/git.ts'
import { emptyQueue, loadQueue, saveQueue } from '../hooks/queue.ts'
import type { QueueIO } from '../hooks/queue.ts'
import { checkout, commit, detach, fakeGit, makeRepo, memoryFs } from './fake-git.ts'

const DATA = 'C:/data/.after-build-quiz'
const STARTED = Date.parse('2026-10-10T08:30:00Z')
const NOW = '2026-10-10T08:30:10.000Z'
const OLD = '2026-09-01T10:00:00Z'

const deps = (run: Run, io: QueueIO) => ({ run, io, dataDir: DATA, isWindows: true, minChangedLines: 10, queueCap: 10 })
const input = (cmd: string, cwd: { tracked?: string; session?: string } = {}) => ({
  command: parseCommit(cmd)!,
  trackedCwd: cwd.tracked,
  sessionCwd: cwd.session ?? 'C:\\session',
  startedAt: STARTED,
  now: NOW,
})
const stored = async (io: QueueIO) => (await loadQueue(io, DATA, NOW)).queue
const queuedRepos = async (io: QueueIO) => (await stored(io)).pending.map(e => e.repo)

// A repo with one fresh commit, so a first-sight detection queues exactly it.
const freshRepo = (top: string) => {
  const repo = makeRepo(top)
  commit(repo, { committedAt: '2026-10-10T08:30:05Z' })
  return repo
}

describe('detectCommits: which repo', () => {
  test('-C beats cd, tracked and session', async () => {
    const fs = memoryFs()
    const git = fakeGit(freshRepo('D:/b'), freshRepo('C:/a'))
    await detectCommits(deps(git.run, fs.io), input('cd C:/a && git -C D:/b commit -m x', { tracked: 'C:\\a', session: 'C:\\a' }))
    expect(await queuedRepos(fs.io)).toEqual(['D:/b'])
  })

  test('the cd target beats tracked and session', async () => {
    const fs = memoryFs()
    const git = fakeGit(freshRepo('C:/a'), freshRepo('C:/t'), freshRepo('C:/s'))
    await detectCommits(deps(git.run, fs.io), input('cd C:/a && git commit -m x', { tracked: 'C:\\t', session: 'C:\\s' }))
    expect(await queuedRepos(fs.io)).toEqual(['C:/a'])
  })

  test('the tracked cwd beats the session cwd', async () => {
    const fs = memoryFs()
    const git = fakeGit(freshRepo('C:/t'), freshRepo('C:/s'))
    await detectCommits(deps(git.run, fs.io), input('git commit -m x', { tracked: 'C:\\t', session: 'C:\\s' }))
    expect(await queuedRepos(fs.io)).toEqual(['C:/t'])
  })

  test('the first candidate that is a repo wins', async () => {
    const fs = memoryFs()
    const git = fakeGit(freshRepo('C:/s'))
    await detectCommits(deps(git.run, fs.io), input('git -C C:/not-a-repo commit -m x', { session: 'C:\\s' }))
    expect(git.calls.slice(0, 2).map(call => call[2])).toEqual(['C:/not-a-repo', 'C:/s'])
    expect(await queuedRepos(fs.io)).toEqual(['C:/s'])
  })

  test('a relative cd resolves against the directory from before the command', async () => {
    const fs = memoryFs()
    const git = fakeGit(freshRepo('C:/work/pkg'))
    await detectCommits(deps(git.run, fs.io), input('cd pkg && git commit -m x', { tracked: 'C:\\work' }))
    expect(git.calls[0]![2]).toBe('C:/work/pkg')
    expect(await queuedRepos(fs.io)).toEqual(['C:/work/pkg'])
  })

  test('a Git Bash path becomes a drive path before git -C', async () => {
    const fs = memoryFs()
    const git = fakeGit(freshRepo('C:/work/foo'))
    await detectCommits(deps(git.run, fs.io), input('cd /c/work/foo && git commit -m x'))
    expect(git.calls[0]![2]).toBe('C:/work/foo')
  })

  test('/cygdrive and a lowercase drive letter', async () => {
    const fs = memoryFs()
    const git = fakeGit(freshRepo('D:/b'))
    await detectCommits(deps(git.run, fs.io), input('git -C /cygdrive/d/b commit -m x'))
    expect(git.calls[0]![2]).toBe('D:/b')
  })

  for (const cmd of [
    'git -C ~/x commit -m x',
    'cd $HOME/x && git commit -m x',
    'cd /usr/src && git commit -m x',
    'git -C \\\\server\\share commit -m x',
  ]) {
    test(`an unrecognised path means zero git calls: ${cmd}`, async () => {
      const fs = memoryFs()
      const git = fakeGit(freshRepo('C:/session'))
      const outcome = await detectCommits(deps(git.run, fs.io), input(cmd))
      expect(outcome.queued).toBe(0)
      expect(git.calls).toEqual([])
      expect(fs.writes).toEqual([])
    })
  }
})

describe('detectCommits: lastSeen is keyed by repo and branch', () => {
  test('switching to a branch with my older commits, then committing, queues only the new commit', async () => {
    const top = 'C:/work/foo'
    const repo = makeRepo(top)
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await saveQueue(fs.io, DATA, { ...emptyQueue(), lastSeen: { [`${top}::main`]: base.hash } })
    repo.branches.set('feature', base.hash)
    checkout(repo, 'feature')
    commit(repo, { committedAt: '2026-09-15T10:00:00Z' })
    commit(repo, { committedAt: '2026-09-16T10:00:00Z' })
    const made = commit(repo, { committedAt: '2026-10-10T08:30:05Z' })

    await detectCommits(deps(fakeGit(repo).run, fs.io), input('git commit -m on-feature', { session: 'C:\\work\\foo' }))

    const queue = await stored(fs.io)
    expect(queue.pending.map(e => e.hash)).toEqual([made.hash])
    expect(queue.lastSeen).toEqual({ [`${top}::main`]: base.hash, [`${top}::feature`]: made.hash })
  })

  test('a commit on a detached HEAD is queued under the key HEAD', async () => {
    const top = 'C:/work/foo'
    const repo = makeRepo(top)
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await saveQueue(fs.io, DATA, { ...emptyQueue(), lastSeen: { [`${top}::main`]: base.hash } })
    detach(repo)
    const made = commit(repo, { committedAt: '2026-10-10T08:30:05Z' })

    await detectCommits(deps(fakeGit(repo).run, fs.io), input('git commit -m detached', { session: 'C:\\work\\foo' }))

    const queue = await stored(fs.io)
    expect(queue.pending.map(e => e.hash)).toEqual([made.hash])
    expect(queue.lastSeen[`${top}::HEAD`]).toBe(made.hash)
  })
})
