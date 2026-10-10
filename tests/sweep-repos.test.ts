import { describe, expect, test } from 'claude-code/testing'

import type { Run } from '../hooks/git.ts'
import type { Exists } from '../hooks/paths.ts'
import { emptyQueue, loadQueue, saveQueue } from '../hooks/queue.ts'
import type { Queue, QueueIO } from '../hooks/queue.ts'
import { SWEEP_REPO_CAP, sweepRepos } from '../hooks/sweep.ts'
import { commit, fakeGit, makeRepo, memoryFs } from './fake-git.ts'
import type { FakeRepo } from './fake-git.ts'

const DATA = 'C:/data/.after-build-quiz'
const NOW = '2026-10-10T09:00:00.000Z'
const OLD = '2026-09-01T10:00:00Z'

const deps = (run: Run, io: QueueIO, exists: Exists = async () => true) =>
  ({ run, io, exists, dataDir: DATA, isWindows: true, minChangedLines: 10, queueCap: 10 })
const input = (sessionCwd = 'C:\\work\\foo') => ({ sessionCwd, now: NOW })
const stored = async (io: QueueIO) => (await loadQueue(io, DATA, NOW)).queue
const seed = (io: QueueIO, queue: Partial<Queue>) => saveQueue(io, DATA, { ...emptyQueue(), ...queue })
const sweptDirs = (calls: string[][]) => calls.filter(call => call[4] === 'rev-parse').map(call => call[2])

// A repo whose HEAD is already lastSeen, plus one outside commit when asked.
const known = (top: string, withNewCommit = false) => {
  const repo = makeRepo(top)
  const base = commit(repo, { committedAt: OLD })
  const made = withNewCommit ? commit(repo, { committedAt: '2026-10-09T10:00:00Z' }) : undefined
  return { repo, base, made }
}

describe('sweepRepos: which repos', () => {
  test('the session repo and the repos in lastSeen are swept, session first', async () => {
    const foo = known('C:/work/foo')
    const bar = known('C:/work/bar', true)
    const baz = known('D:/baz', true)
    const fs = memoryFs()
    await seed(fs.io, {
      lastSeen: { 'C:/work/bar::main': bar.base.hash, 'D:/baz::main': baz.base.hash, 'C:/work/foo::main': foo.base.hash },
      seenAt: { 'C:/work/bar': '2026-10-01T00:00:00Z', 'D:/baz': '2026-10-02T00:00:00Z' },
    })
    const git = fakeGit(foo.repo, bar.repo, baz.repo)

    await sweepRepos(deps(git.run, fs.io), input())

    expect(sweptDirs(git.calls)).toEqual(['C:/work/foo', 'D:/baz', 'C:/work/bar'])
    expect((await stored(fs.io)).pending.map(e => e.hash).sort()).toEqual([bar.made!.hash, baz.made!.hash].sort())
  })

  test('a folder that is gone gets no git call', async () => {
    const foo = known('C:/work/foo')
    const fs = memoryFs()
    await seed(fs.io, { lastSeen: { 'C:/gone::main': 'a'.repeat(40), 'C:/work/foo::main': foo.base.hash } })
    const git = fakeGit(foo.repo)

    await sweepRepos(deps(git.run, fs.io, async path => path !== 'C:/gone'), input())

    expect(sweptDirs(git.calls)).toEqual(['C:/work/foo'])
  })

  test('a folder that is no longer a repo is skipped; the rest still swept', async () => {
    const bar = known('C:/work/bar', true)
    const fs = memoryFs()
    await seed(fs.io, { lastSeen: { 'C:/was-a-repo::main': 'a'.repeat(40), 'C:/work/bar::main': bar.base.hash } })
    const git = fakeGit(bar.repo)

    const outcome = await sweepRepos(deps(git.run, fs.io), input('C:\\not-a-repo'))

    expect(outcome.queued).toBe(1)
    expect((await stored(fs.io)).lastSeen['C:/was-a-repo::main']).toBe('a'.repeat(40))
  })

  test(`the cap keeps the ${SWEEP_REPO_CAP} most recently seen, the session repo among them`, async () => {
    const session = known('C:/work/foo')
    const others = Array.from({ length: 25 }, (_, i) => known(`C:/r/${String(i + 1).padStart(2, '0')}`))
    const fs = memoryFs()
    await seed(fs.io, {
      lastSeen: Object.fromEntries([session, ...others].map(o => [`${o.repo.top}::main`, o.base.hash])),
      // r/25 seen most recently, r/01 longest ago
      seenAt: Object.fromEntries(others.map((o, i) => [o.repo.top, `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`])),
    })
    const repos: FakeRepo[] = [session.repo, ...others.map(o => o.repo)]
    const git = fakeGit(...repos)

    await sweepRepos(deps(git.run, fs.io), input())

    const expected = ['C:/work/foo', ...others.slice(-(SWEEP_REPO_CAP - 1)).reverse().map(o => o.repo.top)]
    expect(SWEEP_REPO_CAP).toBe(20)
    expect(sweptDirs(git.calls)).toEqual(expected)
  })

  test('two branches of one repo: the repo is swept once', async () => {
    const bar = known('C:/work/bar')
    const fs = memoryFs()
    await seed(fs.io, { lastSeen: { 'C:/work/bar::main': bar.base.hash, 'C:/work/bar::feature': bar.base.hash } })
    const git = fakeGit(bar.repo)

    await sweepRepos(deps(git.run, fs.io), input('C:\\not-a-repo'))

    expect(sweptDirs(git.calls).filter(dir => dir === 'C:/work/bar').length).toBe(1)
  })

  test('an unrecognised session cwd: only the lastSeen repos are swept', async () => {
    const bar = known('C:/work/bar')
    const fs = memoryFs()
    await seed(fs.io, { lastSeen: { 'C:/work/bar::main': bar.base.hash } })
    const git = fakeGit(bar.repo)

    await sweepRepos(deps(git.run, fs.io), input('\\\\server\\share'))

    expect(sweptDirs(git.calls)).toEqual(['C:/work/bar'])
  })
})
