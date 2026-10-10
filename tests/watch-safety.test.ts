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
const READ_ONLY = new Set(['rev-parse', 'log', 'show', 'cat-file', 'config'])

const deps = (run: Run, io: QueueIO) => ({ run, io, dataDir: DATA, isWindows: true, minChangedLines: 10, queueCap: 10 })
const input = (cmd: string) => ({
  command: parseCommit(cmd)!, trackedCwd: undefined, sessionCwd: 'C:\\work\\foo', startedAt: STARTED, now: NOW,
})
const stored = async (io: QueueIO) => (await loadQueue(io, DATA, NOW)).queue

describe('detectCommits: author matching is exact', () => {
  test('an author whose email contains mine is excluded (-F, angle brackets)', async () => {
    const repo = makeRepo(TOP, 'a.b@example.com')
    const base = commit(repo, { committedAt: OLD })
    const fs = memoryFs()
    await saveQueue(fs.io, DATA, { ...emptyQueue(), lastSeen: { [MAIN_KEY]: base.hash } })
    const mine = commit(repo, { email: 'a.b@example.com', committedAt: '2026-10-10T08:30:01Z' })
    commit(repo, { email: 'xa.b@example.com', committedAt: '2026-10-10T08:30:02Z' })
    commit(repo, { email: 'aXb@example.com', committedAt: '2026-10-10T08:30:03Z' })
    commit(repo, { email: 'a.b@example.com.evil', committedAt: '2026-10-10T08:30:04Z' })
    const git = fakeGit(repo)

    await detectCommits(deps(git.run, fs.io), input('git pull && git commit -m mine'))

    expect((await stored(fs.io)).pending.map(e => e.hash)).toEqual([mine.hash])
    const log = git.calls.find(call => call[4] === 'log')!
    expect(log).toContain('-F')
    expect(log).toContain('--author=<a.b@example.com>')
  })
})

describe('detectCommits: never throws, never writes outside dataDir', () => {
  test('every git call goes through git.ts and is read-only', async () => {
    const repo = makeRepo(TOP)
    commit(repo, { committedAt: OLD })
    commit(repo)
    const fs = memoryFs()
    const git = fakeGit(repo)

    await detectCommits(deps(git.run, fs.io), input('git commit -m x'))

    expect(git.calls.length > 0).toBe(true)
    for (const call of git.calls) {
      expect(call[3]).toBe('--no-pager')
      expect(READ_ONLY.has(call[4]!)).toBe(true)
    }
  })

  test('git throwing: resolves, nothing queued, nothing written', async () => {
    const fs = memoryFs()
    const run: Run = async () => { throw new Error('spawn git ENOENT') }

    const outcome = await detectCommits(deps(run, fs.io), input('git commit -m x'))

    expect(outcome.queued).toBe(0)
    expect(fs.writes).toEqual([])
  })

  test('an unreadable queue: nothing written, notice returned', async () => {
    const repo = makeRepo(TOP)
    commit(repo)
    const fs = memoryFs()
    fs.makeUnreadable(`${DATA}/queue.json`)

    const outcome = await detectCommits(deps(fakeGit(repo).run, fs.io), input('git commit -m x'))

    expect(outcome.notice).toBeDefined()
    expect(fs.writes).toEqual([])
  })

  test('a corrupt queue: copied aside, notice, detection carries on', async () => {
    const repo = makeRepo(TOP)
    commit(repo)
    const fs = memoryFs({ [`${DATA}/queue.json`]: '{ broken' })

    const outcome = await detectCommits(deps(fakeGit(repo).run, fs.io), input('git commit -m x'))

    expect(outcome.notice).toContain('corrupt')
    expect(outcome.queued).toBe(1)
  })

  test('every write lands under dataDir', async () => {
    const repo = makeRepo(TOP)
    commit(repo)
    const fs = memoryFs({ [`${DATA}/queue.json`]: '{ broken' })

    await detectCommits(deps(fakeGit(repo).run, fs.io), input('git commit -m x'))

    expect(fs.writes.length > 0).toBe(true)
    for (const path of fs.writes) expect(path.startsWith(`${DATA}/`)).toBe(true)
  })
})
