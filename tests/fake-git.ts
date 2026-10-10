// Test helpers (not a test file): an in-memory git that answers exactly the
// argv hooks/git.ts sends, and an in-memory fs. Behaviour the fake assumes about
// real git (one-call rev-parse output, -F --author matching, --since) is
// checked against real git in tests/integration/git-cat-file.mjs.
import type { ProcessRunResult } from 'claude-code'

import type { Run } from '../hooks/git.ts'
import { COMMIT_FORMAT } from '../hooks/queue.ts'
import type { QueueIO } from '../hooks/queue.ts'

export type FakeCommit = {
  hash: string
  parents: string[]
  name: string
  email: string
  authoredAt: string
  committedAt: string
  subject: string
  numstat: string
}

export type FakeRepo = {
  top: string
  email: string | undefined
  commits: Map<string, FakeCommit>
  branches: Map<string, string>
  head: { branch: string | undefined; sha: string | undefined } // branch undefined = detached
}

let shaCounter = 0
const nextSha = () => (++shaCounter).toString(16).padStart(40, 'a')

// email null = no user.email configured
export const makeRepo = (top: string, email: string | null = 'me@example.com'): FakeRepo => ({
  top, email: email ?? undefined, commits: new Map(), branches: new Map(), head: { branch: 'main', sha: undefined },
})

export const CODE_20 = '15\t5\tsrc/feature.ts\n'
export const DOCS_ONLY = '40\t2\tREADME.md\n'

export const commit = (
  repo: FakeRepo,
  options: { subject?: string; numstat?: string; email?: string; committedAt?: string; authoredAt?: string; parents?: string[] } = {},
): FakeCommit => {
  const committedAt = options.committedAt ?? '2026-10-10T08:30:05Z'
  const made: FakeCommit = {
    hash: nextSha(),
    parents: options.parents ?? (repo.head.sha === undefined ? [] : [repo.head.sha]),
    name: 'Someone',
    email: options.email ?? repo.email ?? 'me@example.com',
    authoredAt: options.authoredAt ?? committedAt,
    committedAt,
    subject: options.subject ?? `commit ${shaCounter}`,
    numstat: options.numstat ?? CODE_20,
  }
  repo.commits.set(made.hash, made)
  repo.head.sha = made.hash
  if (repo.head.branch !== undefined) repo.branches.set(repo.head.branch, made.hash)
  return made
}

// `git commit --amend`: a new commit with the parent of the one it replaces.
export const amend = (repo: FakeRepo, options: { committedAt?: string } = {}): FakeCommit => {
  const replaced = repo.commits.get(repo.head.sha!)!
  return commit(repo, { ...options, parents: replaced.parents })
}

export const checkout = (repo: FakeRepo, branch: string) => {
  repo.head = { branch, sha: repo.branches.get(branch) }
}

export const detach = (repo: FakeRepo) => {
  repo.head = { branch: undefined, sha: repo.head.sha }
}

const result = (exitCode: number, stdout = '', stderr = ''): ProcessRunResult => ({
  exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false,
})

const ancestors = (repo: FakeRepo, from: string): Set<string> => {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length > 0) {
    const sha = stack.pop()!
    if (seen.has(sha)) continue
    seen.add(sha)
    stack.push(...(repo.commits.get(sha)?.parents ?? []))
  }
  return seen
}

const formatLine = (c: FakeCommit) =>
  [c.hash, c.parents.join(' '), c.authoredAt, c.committedAt, c.subject].join('\x1f')

const answerLog = (repo: FakeRepo, args: string[]): ProcessRunResult => {
  let limit = Infinity
  let author: string | undefined
  let isFixed = false
  let since: number | undefined
  let isNoMerges = false
  let format: string | undefined
  const revs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--no-ext-diff' || arg === '--no-textconv') continue
    else if (arg === '--no-merges') isNoMerges = true
    else if (arg === '-F') isFixed = true
    else if (arg === '-n') limit = Number(args[++i])
    else if (arg.startsWith('--format=')) format = arg.slice('--format='.length)
    else if (arg.startsWith('--author=')) author = arg.slice('--author='.length)
    else if (arg.startsWith('--since=')) since = Date.parse(arg.slice('--since='.length))
    else if (arg.startsWith('-')) return result(129, '', `fake git: unexpected log option ${arg}`)
    else revs.push(arg)
  }
  if (format !== COMMIT_FORMAT) return result(129, '', 'fake git: unexpected --format')
  if (repo.head.sha === undefined) return result(128, '', "fatal: ambiguous argument 'HEAD'")

  let excluded = new Set<string>()
  for (const rev of revs) {
    const range = /^(.+)\.\.HEAD$/.exec(rev)
    if (range !== null) {
      if (!repo.commits.has(range[1]!)) return result(128, '', `fatal: bad revision '${rev}'`)
      excluded = ancestors(repo, range[1]!)
    } else if (rev !== 'HEAD') {
      return result(128, '', `fatal: bad revision '${rev}'`)
    }
  }

  const matchesAuthor = (c: FakeCommit) => {
    if (author === undefined) return true
    const ident = `${c.name} <${c.email}>`
    return isFixed ? ident.includes(author) : new RegExp(author).test(ident)
  }

  const lines = [...ancestors(repo, repo.head.sha)]
    .filter(sha => !excluded.has(sha))
    .map(sha => repo.commits.get(sha)!)
    .filter(c => !isNoMerges || c.parents.length < 2)
    .filter(matchesAuthor)
    .filter(c => since === undefined || Date.parse(c.committedAt) >= since)
    .sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt))
    .slice(0, limit)
    .map(formatLine)
  return result(0, lines.length === 0 ? '' : `${lines.join('\n')}\n`)
}

const answer = (repo: FakeRepo, args: string[]): ProcessRunResult => {
  const joined = args.join(' ')
  if (joined === 'rev-parse --show-toplevel HEAD --abbrev-ref HEAD') {
    if (repo.head.sha === undefined) return result(128, `${repo.top}\nHEAD\n`, "fatal: ambiguous argument 'HEAD'")
    return result(0, `${repo.top}\n${repo.head.sha}\n${repo.head.branch ?? 'HEAD'}\n`)
  }
  if (joined === 'rev-parse --is-inside-work-tree') return result(0, 'true\n')
  if (joined === 'config --get user.email') {
    return repo.email === undefined ? result(1) : result(0, `${repo.email}\n`)
  }
  if (args[0] === 'log') return answerLog(repo, args.slice(1))
  if (args[0] === 'show') {
    const sha = args.at(-1)!
    const wanted = ['show', '--no-ext-diff', '--no-textconv', '-w', '--numstat', '--format=', sha].join(' ')
    if (joined !== wanted) return result(129, '', `fake git: unexpected show ${joined}`)
    const found = repo.commits.get(sha)
    return found === undefined ? result(128, '', 'fatal: bad object') : result(0, found.numstat)
  }
  return result(129, '', `fake git: unsupported ${joined}`)
}

export const fakeGit = (...repos: FakeRepo[]) => {
  const calls: string[][] = []
  const run: Run = async argv => {
    calls.push([...argv])
    const [exe, dashC, dir, noPager, ...args] = argv
    if (exe !== 'git' || dashC !== '-C' || noPager !== '--no-pager' || dir === undefined) {
      return result(129, '', 'fake git: not called through git.ts')
    }
    const repo = repos.find(r => dir === r.top || dir.startsWith(`${r.top}/`))
    if (repo === undefined) return result(128, '', 'fatal: not a git repository (or any of the parent directories): .git')
    return answer(repo, args)
  }
  return { run, calls }
}

export const memoryFs = (files: Record<string, string> = {}) => {
  const store = new Map(Object.entries(files))
  const writes: string[] = []
  const unreadable = new Set<string>()
  const io: QueueIO = {
    read: async path => {
      if (unreadable.has(path)) throw new Error('EIO')
      const text = store.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    write: async (path, text) => {
      writes.push(path)
      store.set(path, text)
    },
    exists: async path => store.has(path) || unreadable.has(path),
  }
  return { io, store, writes, makeUnreadable: (path: string) => unreadable.add(path) }
}
