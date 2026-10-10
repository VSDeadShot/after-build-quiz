import { describe, expect, test } from 'claude-code/testing'

import type { Run } from '../hooks/git.ts'
import type { Exists } from '../hooks/paths.ts'
import { emptyQueue, loadQueue, saveQueue } from '../hooks/queue.ts'
import type { QueueIO } from '../hooks/queue.ts'
import { sweepRepos } from '../hooks/sweep.ts'
import { commit, fakeGit, makeRepo, memoryFs } from './fake-git.ts'

const DATA = 'C:/data/.after-build-quiz'
const NOW = '2026-10-10T09:00:00.000Z'
const OLD = '2026-09-01T10:00:00Z'
const READ_ONLY = new Set(['rev-parse', 'log', 'show', 'cat-file', 'config'])

const anywhere: Exists = async () => true
const deps = (run: Run, io: QueueIO) =>
  ({ run, io, exists: anywhere, dataDir: DATA, isWindows: true, minChangedLines: 10, queueCap: 10 })
const input = { sessionCwd: 'C:\\work\\foo', now: NOW }
const stored = async (io: QueueIO) => (await loadQueue(io, DATA, NOW)).queue

// Two known repos, each with one outside commit to catch up on.
const twoRepos = async () => {
  const foo = makeRepo('C:/work/foo')
  const bar = makeRepo('C:/work/bar')
  const fooBase = commit(foo, { committedAt: OLD })
  const barBase = commit(bar, { committedAt: OLD })
  const fs = memoryFs()
  await saveQueue(fs.io, DATA, {
    ...emptyQueue(),
    lastSeen: { 'C:/work/foo::main': fooBase.hash, 'C:/work/bar::main': barBase.hash },
  })
  const fooMade = commit(foo, { committedAt: '2026-10-09T10:00:00Z' })
  const barMade = commit(bar, { committedAt: '2026-10-09T11:00:00Z' })
  fs.writes.length = 0
  return { foo, bar, fooMade, barMade, fs }
}

describe('sweepRepos: never throws, never writes outside dataDir', () => {
  test('git throwing in one repo: the others are still swept, the error is reported', async () => {
    const { foo, bar, barMade, fs } = await twoRepos()
    const git = fakeGit(foo, bar)
    const run: Run = async (argv, init) => {
      if (argv[2] === 'C:/work/foo') throw new Error('spawn git EPERM')
      return git.run(argv, init)
    }

    const outcome = await sweepRepos(deps(run, fs.io), input)

    expect(outcome.queued).toBe(1)
    expect((await stored(fs.io)).pending.map(e => e.hash)).toEqual([barMade.hash])
    expect(outcome.errors.length).toBe(1)
    expect(outcome.errors[0]).toContain('C:/work/foo')
  })

  test('every git call has --no-pager and is read-only', async () => {
    const { foo, bar, fs } = await twoRepos()
    const git = fakeGit(foo, bar)

    await sweepRepos(deps(git.run, fs.io), input)

    expect(git.calls.length > 0).toBe(true)
    for (const call of git.calls) {
      expect(call[3]).toBe('--no-pager')
      expect(READ_ONLY.has(call[4]!)).toBe(true)
    }
  })

  test('writes land under dataDir, one save per sweep', async () => {
    const { foo, bar, fs } = await twoRepos()

    await sweepRepos(deps(fakeGit(foo, bar).run, fs.io), input)

    expect(fs.writes).toEqual([`${DATA}/queue.json.tmp`, `${DATA}/queue.json`])
  })

  test('an unreadable queue: no git, nothing written, notice returned', async () => {
    const { foo, bar } = await twoRepos()
    const fs = memoryFs()
    fs.makeUnreadable(`${DATA}/queue.json`)
    const git = fakeGit(foo, bar)

    const outcome = await sweepRepos(deps(git.run, fs.io), input)

    expect(outcome.notice).toBeDefined()
    expect(git.calls).toEqual([])
    expect(fs.writes).toEqual([])
  })
})
