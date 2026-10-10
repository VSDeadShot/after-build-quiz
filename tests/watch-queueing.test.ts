import { describe, expect, test } from 'claude-code/testing'

import { detectCommits, parseCommit } from '../hooks/detect.ts'
import type { Run } from '../hooks/git.ts'
import { emptyQueue, loadQueue, saveQueue } from '../hooks/queue.ts'
import type { QueueIO } from '../hooks/queue.ts'
import { amend, CODE_20, commit, DOCS_ONLY, fakeGit, makeRepo, memoryFs } from './fake-git.ts'

const DATA = 'C:/data/.after-build-quiz'
const STARTED = Date.parse('2026-10-10T08:30:00Z')
const NOW = '2026-10-10T08:30:10.000Z'
const OLD = '2026-09-01T10:00:00Z'
const TOP = 'C:/work/foo'
const MAIN_KEY = `${TOP}::main`

const deps = (run: Run, io: QueueIO, queueCap = 10) => ({ run, io, dataDir: DATA, isWindows: true, minChangedLines: 10, queueCap })
const input = (cmd: string) => ({
  command: parseCommit(cmd)!, trackedCwd: undefined, sessionCwd: 'C:\\work\\foo', startedAt: STARTED, now: NOW,
})
const seen = (io: QueueIO, lastSeen: Record<string, string>) => saveQueue(io, DATA, { ...emptyQueue(), lastSeen })
const stored = async (io: QueueIO) => (await loadQueue(io, DATA, NOW)).queue

describe('detectCommits: queueing', () => {
  test('a new commit is queued with committer date, parent and line counts', async () => {
    const repo = makeRepo(TOP)
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await seen(fs.io, { [MAIN_KEY]: base.hash })
    const made = commit(repo, { subject: 'Add retry', authoredAt: '2026-01-01T00:00:00Z', committedAt: '2026-10-10T08:30:05Z' })
    const git = fakeGit(repo)

    const outcome = await detectCommits(deps(git.run, fs.io), input('git commit -m "Add retry"'))

    expect(outcome.queued).toBe(1)
    const queue = await stored(fs.io)
    expect(queue.pending).toEqual([{
      repo: TOP, repoName: 'foo', hash: made.hash, parent: base.hash, subject: 'Add retry',
      committedAt: '2026-10-10T08:30:05Z', queuedAt: NOW, source: 'claude-code', codeLines: 20, codeFiles: 1,
    }])
    expect(queue.lastSeen[MAIN_KEY]).toBe(made.hash)
  })

  test('git commit && git commit queues both, oldest first', async () => {
    const repo = makeRepo(TOP)
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await seen(fs.io, { [MAIN_KEY]: base.hash })
    const first = commit(repo, { committedAt: '2026-10-10T08:30:05Z' })
    const second = commit(repo, { committedAt: '2026-10-10T08:30:07Z' })

    const outcome = await detectCommits(deps(fakeGit(repo).run, fs.io), input('git commit -m a && git commit -m b'))

    expect(outcome.queued).toBe(2)
    expect((await stored(fs.io)).pending.map(e => e.hash)).toEqual([first.hash, second.hash])
  })

  test('a trivial commit is skipped but lastSeen still advances', async () => {
    const repo = makeRepo(TOP)
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await seen(fs.io, { [MAIN_KEY]: base.hash })
    commit(repo, { numstat: DOCS_ONLY, committedAt: '2026-10-10T08:30:05Z' })
    const real = commit(repo, { numstat: CODE_20, committedAt: '2026-10-10T08:30:07Z' })

    await detectCommits(deps(fakeGit(repo).run, fs.io), input('git commit -m a && git commit -m b'))

    const queue = await stored(fs.io)
    expect(queue.pending.map(e => e.hash)).toEqual([real.hash])
    expect(queue.lastSeen[MAIN_KEY]).toBe(real.hash)
  })

  test('only trivial commits: nothing queued, lastSeen saved', async () => {
    const repo = makeRepo(TOP)
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await seen(fs.io, { [MAIN_KEY]: base.hash })
    const docs = commit(repo, { numstat: DOCS_ONLY })

    const outcome = await detectCommits(deps(fakeGit(repo).run, fs.io), input('git commit -m docs'))

    expect(outcome.queued).toBe(0)
    const queue = await stored(fs.io)
    expect(queue.pending).toEqual([])
    expect(queue.lastSeen[MAIN_KEY]).toBe(docs.hash)
  })

  test('an amend replaces the pending entry', async () => {
    const repo = makeRepo(TOP)
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await seen(fs.io, { [MAIN_KEY]: base.hash })
    commit(repo, { committedAt: '2026-10-10T08:30:05Z' })
    const git = fakeGit(repo)
    await detectCommits(deps(git.run, fs.io), input('git commit -m first'))
    const amended = amend(repo, { committedAt: '2026-10-10T08:31:00Z' })

    await detectCommits(deps(git.run, fs.io), input('git commit --amend --no-edit'))

    expect((await stored(fs.io)).pending.map(e => e.hash)).toEqual([amended.hash])
  })

  test('the cap limits how many are queued (-n cap)', async () => {
    const repo = makeRepo(TOP)
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await seen(fs.io, { [MAIN_KEY]: base.hash })
    const made = Array.from({ length: 12 }, (_, i) =>
      commit(repo, { committedAt: `2026-10-10T08:30:${String(10 + i).padStart(2, '0')}Z` }))
    const git = fakeGit(repo)

    await detectCommits(deps(git.run, fs.io, 10), input('git commit -m many'))

    const log = git.calls.find(call => call[4] === 'log')!
    expect(log.join(' ')).toContain('-n 10')
    expect((await stored(fs.io)).pending.map(e => e.hash)).toEqual(made.slice(2).map(c => c.hash))
  })

  test('the outcome carries the saved queue (for the status line)', async () => {
    const repo = makeRepo(TOP)
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await seen(fs.io, { [MAIN_KEY]: base.hash })
    commit(repo)

    const outcome = await detectCommits(deps(fakeGit(repo).run, fs.io), input('git commit -m x'))

    expect(outcome.queue).toEqual(await stored(fs.io))
  })
})
