import { describe, expect, test } from 'claude-code/testing'

import type { Run } from '../hooks/git.ts'
import type { Exists } from '../hooks/paths.ts'
import { emptyQueue, loadQueue, saveQueue } from '../hooks/queue.ts'
import type { Queue, QueueEntry, QueueIO } from '../hooks/queue.ts'
import { sweepRepos } from '../hooks/sweep.ts'
import { amend, commit, DOCS_ONLY, fakeGit, makeRepo, memoryFs } from './fake-git.ts'
import type { FakeCommit } from './fake-git.ts'

const DATA = 'C:/data/.after-build-quiz'
const NOW = '2026-10-10T09:00:00.000Z'
const OLD = '2026-09-01T10:00:00Z'
const TOP = 'C:/work/foo'
const MAIN_KEY = `${TOP}::main`

const anywhere: Exists = async () => true
const deps = (run: Run, io: QueueIO) =>
  ({ run, io, exists: anywhere, dataDir: DATA, isWindows: true, minChangedLines: 10, queueCap: 10 })
const input = { sessionCwd: 'C:\\work\\foo', now: NOW }
const stored = async (io: QueueIO) => (await loadQueue(io, DATA, NOW)).queue
const seed = (io: QueueIO, queue: Partial<Queue>) => saveQueue(io, DATA, { ...emptyQueue(), ...queue })
const pendingFor = (made: FakeCommit): QueueEntry => ({
  repo: TOP, repoName: 'foo', hash: made.hash, parent: made.parents[0] ?? null, subject: made.subject,
  committedAt: made.committedAt, queuedAt: OLD, source: 'claude-code', codeLines: 20, codeFiles: 1,
})

describe('sweepRepos: catching up on commits made outside Claude Code', () => {
  test('outside commits are queued oldest first, source sweep; lastSeen advances', async () => {
    const repo = makeRepo(TOP)
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await seed(fs.io, { lastSeen: { [MAIN_KEY]: base.hash } })
    const first = commit(repo, { committedAt: '2026-10-09T10:00:00Z' })
    const second = commit(repo, { committedAt: '2026-10-09T11:00:00Z' })

    const outcome = await sweepRepos(deps(fakeGit(repo).run, fs.io), input)

    expect(outcome.queued).toBe(2)
    const queue = await stored(fs.io)
    expect(queue.pending.map(e => [e.hash, e.source])).toEqual([[first.hash, 'sweep'], [second.hash, 'sweep']])
    expect(queue.lastSeen[MAIN_KEY]).toBe(second.hash)
    expect(queue.seenAt[TOP]).toBe(NOW)
  })

  test('a teammate and an email containing mine are excluded (-F exact match)', async () => {
    const repo = makeRepo(TOP, 'a.b@example.com')
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await seed(fs.io, { lastSeen: { [MAIN_KEY]: base.hash } })
    const mine = commit(repo, { email: 'a.b@example.com', committedAt: '2026-10-09T10:00:00Z' })
    commit(repo, { email: 'teammate@example.com', committedAt: '2026-10-09T11:00:00Z' })
    commit(repo, { email: 'xa.b@example.com', committedAt: '2026-10-09T12:00:00Z' })
    const git = fakeGit(repo)

    await sweepRepos(deps(git.run, fs.io), input)

    expect((await stored(fs.io)).pending.map(e => e.hash)).toEqual([mine.hash])
    const log = git.calls.find(call => call[4] === 'log')!
    expect(log).toContain('-F')
    expect(log).toContain('--author=<a.b@example.com>')
  })

  test('trivial commits are skipped; lastSeen still advances', async () => {
    const repo = makeRepo(TOP)
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await seed(fs.io, { lastSeen: { [MAIN_KEY]: base.hash } })
    const docs = commit(repo, { numstat: DOCS_ONLY, committedAt: '2026-10-09T10:00:00Z' })

    await sweepRepos(deps(fakeGit(repo).run, fs.io), input)

    const queue = await stored(fs.io)
    expect(queue.pending).toEqual([])
    expect(queue.lastSeen[MAIN_KEY]).toBe(docs.hash)
  })

  test('an already-pending hash is a no-op (the original entry is kept)', async () => {
    const repo = makeRepo(TOP)
    const base = commit(repo, { committedAt: OLD })
    const made = commit(repo, { committedAt: '2026-10-09T10:00:00Z' })
    const fs = memoryFs()
    await seed(fs.io, { lastSeen: { [MAIN_KEY]: base.hash }, pending: [pendingFor(made)] })

    await sweepRepos(deps(fakeGit(repo).run, fs.io), input)

    expect((await stored(fs.io)).pending).toEqual([pendingFor(made)])
  })

  test('a pruned lastSeen: HEAD becomes the new baseline, nothing queued, no --since', async () => {
    const repo = makeRepo(TOP)
    commit(repo, { committedAt: OLD })
    const head = commit(repo, { committedAt: '2026-10-09T10:00:00Z' })
    const fs = memoryFs()
    await seed(fs.io, { lastSeen: { [MAIN_KEY]: 'f'.repeat(40) } })
    const git = fakeGit(repo)

    const outcome = await sweepRepos(deps(git.run, fs.io), input)

    expect(outcome.queued).toBe(0)
    const queue = await stored(fs.io)
    expect(queue.pending).toEqual([])
    expect(queue.lastSeen[MAIN_KEY]).toBe(head.hash)
    expect(git.calls.some(call => call.some(arg => arg.startsWith('--since')))).toBe(false)
  })

  test('an amend made outside Claude Code replaces the pending entry', async () => {
    const repo = makeRepo(TOP)
    commit(repo, { committedAt: OLD })
    const original = commit(repo, { committedAt: '2026-10-09T10:00:00Z' })
    const fs = memoryFs()
    await seed(fs.io, { lastSeen: { [MAIN_KEY]: original.hash }, pending: [pendingFor(original)] })
    const amended = amend(repo, { committedAt: '2026-10-09T10:30:00Z' })

    await sweepRepos(deps(fakeGit(repo).run, fs.io), input)

    expect((await stored(fs.io)).pending.map(e => e.hash)).toEqual([amended.hash])
  })
})
