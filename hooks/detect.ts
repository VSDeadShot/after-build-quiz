import { git } from './git.ts'
import type { Run } from './git.ts'
import { isAbsolute, normalizeDir } from './paths.ts'
import { COMMIT_FORMAT, enqueue, loadQueue, parseCommitLine, saveQueue } from './queue.ts'
import type { Queue, QueueIO } from './queue.ts'
import { classify } from './trivial.ts'

// Spots a `git commit` inside a Bash or PowerShell command line. A false match
// costs nothing (detection only queues a HEAD that actually moved), so when in
// doubt this leans towards matching.

export type ParsedCommit = {
  isAmend: boolean
  dashC?: string // the `git -C <path>` of the commit, as typed (normalizeDir before use)
  cdTarget?: string // the last cd / Set-Location before the commit, as typed
}

const HERE_STRING = /@(['"])[\s\S]*?\r?\n\1@/g // PowerShell @' … '@ and @" … "@
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?\r?\n\s*\2(?=\s|\)|$)/g // bash <<'EOF' … EOF

const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const COMMIT_OPTIONS_WITH_VALUE = new Set([
  '-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message',
  '--author', '--date', '-t', '--template', '--fixup', '--squash', '--cleanup', '--trailer',
])

// Splits into segments at unquoted &&, ||, ;, |, &, newlines, braces and
// parentheses; each segment is its list of unquoted words.
const segmentsOf = (cmd: string): string[][] => {
  const segments: string[][] = []
  let words: string[] = []
  let word: string | undefined
  let quote: '"' | "'" | undefined

  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]!
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else if (quote === '"' && char === '\\' && cmd[i + 1] === '"') word = (word ?? '') + cmd[++i]
      else word = (word ?? '') + char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      word = word ?? ''
    } else if ('&|;\n(){}'.includes(char)) {
      endSegment()
    } else if (/\s/.test(char)) {
      endWord()
    } else {
      word = (word ?? '') + char
    }
  }
  endSegment()
  return segments
}

const commitIn = (words: readonly string[]): Omit<ParsedCommit, 'cdTarget'> | undefined => {
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++
  if (!/^git(\.exe)?$/i.test(words[i] ?? '')) return undefined
  i++

  let dashC: string | undefined
  while ((words[i] ?? '').startsWith('-')) {
    const option = words[i]!
    if (GIT_OPTIONS_WITH_VALUE.has(option)) {
      if (option === '-C') dashC = words[i + 1]
      i += 2
    } else {
      i++
    }
  }
  if (words[i] !== 'commit') return undefined

  let isAmend = false
  for (let j = i + 1; j < words.length; j++) {
    if (COMMIT_OPTIONS_WITH_VALUE.has(words[j]!)) j++
    else if (words[j] === '--amend') isAmend = true
  }
  return dashC === undefined ? { isAmend } : { isAmend, dashC }
}

const cdTargetIn = (words: readonly string[]): string | undefined => {
  if (!CD.has((words[0] ?? '').toLowerCase())) return undefined
  const target = words.slice(1).find(word => !word.startsWith('-'))
  return target
}

export const parseCommit = (cmd: string): ParsedCommit | undefined => {
  const flat = cmd.replace(HERE_STRING, ' HERE ').replace(HEREDOC, ' HERE ')
  let cdTarget: string | undefined
  for (const words of segmentsOf(flat)) {
    const commit = commitIn(words)
    if (commit !== undefined) return cdTarget === undefined ? commit : { ...commit, cdTarget }
    cdTarget = cdTargetIn(words) ?? cdTarget
  }
  return undefined
}

const resolveAgainst = (path: string, base: string): string => {
  if (isAbsolute(path)) return path
  const relative = path.replace(/^\.\//, '')
  return relative === '.' || relative === '' ? base : `${base}/${relative}`
}

// Where to look for the repo the commit landed in, most likely first.
export const repoCandidates = (
  parsed: ParsedCommit,
  trackedCwd: string | undefined,
  sessionCwd: string,
): string[] => {
  const start = trackedCwd ?? sessionCwd
  const cd = parsed.cdTarget === undefined ? undefined : resolveAgainst(parsed.cdTarget, start)
  const dashC = parsed.dashC === undefined ? undefined : resolveAgainst(parsed.dashC, cd ?? start)
  const ordered = [dashC, cd, trackedCwd, sessionCwd].filter((dir): dir is string => dir !== undefined)
  return [...new Set(ordered)]
}


export type DetectDeps = {
  run: Run
  io: QueueIO
  dataDir: string
  isWindows: boolean
  minChangedLines: number
  queueCap: number
}

export type DetectInput = {
  command: ParsedCommit
  trackedCwd: string | undefined // from CwdChanged, as it was before the command ran
  sessionCwd: string // $.session.cwd(), as it was before the command ran
  startedAt: number // epoch ms, before the command ran
  now: string // ISO, for queuedAt
}

export type DetectOutcome = { queued: number; queue?: Queue; notice?: string }

type Head = { top: string; sha: string; branch: string } // branch is "HEAD" when detached

// The repo the command committed in: the first candidate git recognises.
// undefined when none is a repo, or the first repo found has no commits yet.
const findHead = async (run: Run, candidates: readonly string[], isWindows: boolean): Promise<Head | undefined> => {
  for (const dir of candidates) {
    const found = await git(run, dir, ['rev-parse', '--show-toplevel', 'HEAD', '--abbrev-ref', 'HEAD'])
    const [top, sha, branch] = found.stdout.split(/\r?\n/).filter(line => line !== '')
    if (found.exitCode === 0 && top !== undefined && sha !== undefined && branch !== undefined) {
      return { top: normalizeDir(top, isWindows) ?? top, sha, branch }
    }
    if (top !== undefined) return undefined // a repo with an unborn HEAD: nothing was committed
  }
  return undefined
}

const repoName = (top: string): string => top.split('/').filter(part => part !== '').at(-1) ?? top

const sinceArg = (startedAt: number): string => {
  const second = Math.floor(startedAt / 1000) * 1000 - 1000 // committer dates have whole seconds
  return `--since=${new Date(second).toISOString().replace('.000Z', 'Z')}`
}

const detect = async (deps: DetectDeps, input: DetectInput): Promise<DetectOutcome> => {
  const { run, io, dataDir, isWindows } = deps
  const { command } = input

  // A directory the command names must be recognised, or we skip: never guess.
  const dashC = command.dashC === undefined ? undefined : normalizeDir(command.dashC, isWindows)
  const cdTarget = command.cdTarget === undefined ? undefined : normalizeDir(command.cdTarget, isWindows)
  if ((command.dashC !== undefined && dashC === undefined) || (command.cdTarget !== undefined && cdTarget === undefined)) {
    return { queued: 0 }
  }
  const absolute = (dir: string | undefined) => (dir !== undefined && isAbsolute(dir) ? dir : undefined)
  const tracked = absolute(input.trackedCwd === undefined ? undefined : normalizeDir(input.trackedCwd, isWindows))
  const session = absolute(normalizeDir(input.sessionCwd, isWindows))
  const start = tracked ?? session
  const isRelativeNamed = [dashC, cdTarget].some(dir => dir !== undefined && !isAbsolute(dir))
  if (isRelativeNamed && start === undefined) return { queued: 0 }

  const candidates = repoCandidates({ ...command, dashC, cdTarget }, tracked, start ?? '').filter(isAbsolute)
  const head = await findHead(run, candidates, isWindows)
  if (head === undefined) return { queued: 0 }

  const loaded = await loadQueue(io, dataDir, input.now)
  const withNotice = (outcome: DetectOutcome): DetectOutcome =>
    loaded.notice === undefined ? outcome : { ...outcome, notice: loaded.notice }
  if (!loaded.isWritable) return withNotice({ queued: 0 })

  const key = `${head.top}::${head.branch}`
  const lastSeen = loaded.queue.lastSeen[key]
  if (lastSeen === head.sha) return withNotice({ queued: 0 }) // HEAD did not move: nothing was committed

  // Only my commits, matched exactly: -F with the angle brackets of the ident.
  const email = await git(run, head.top, ['config', '--get', 'user.email'])
  const me = email.exitCode === 0 ? email.stdout.trim() : ''
  const logArgs = (range: string[]) => [
    'log', '--no-merges', `--format=${COMMIT_FORMAT}`, '-n', String(deps.queueCap),
    ...(me === '' ? [] : ['-F', `--author=<${me}>`]),
    ...range,
  ]
  // lastSeen..HEAD for a repo and branch seen before; otherwise (first sight,
  // or lastSeen pruned) only commits made since the command started.
  let log = lastSeen === undefined ? undefined : await git(run, head.top, logArgs([`${lastSeen}..HEAD`]))
  if (log === undefined || log.exitCode !== 0) log = await git(run, head.top, logArgs([sinceArg(input.startedAt), 'HEAD']))
  if (log.exitCode !== 0) return withNotice({ queued: 0 })

  const commits = log.stdout
    .split(/\r?\n/)
    .flatMap(line => parseCommitLine(line) ?? [])
    .reverse() // git lists newest first
  let queue = loaded.queue
  let queued = 0
  for (const made of commits) {
    const shown = await git(run, head.top, ['show', '-w', '--numstat', '--format=', made.hash])
    if (shown.exitCode !== 0) continue
    const verdict = classify(shown.stdout, made.parents.length, deps.minChangedLines)
    if (verdict.kind !== 'queue') continue
    queue = enqueue(queue, {
      repo: head.top,
      repoName: repoName(head.top),
      hash: made.hash,
      parent: made.parents[0] ?? null,
      subject: made.subject,
      committedAt: made.committedAt,
      queuedAt: input.now,
      source: 'claude-code',
      codeLines: verdict.codeLines,
      codeFiles: verdict.codeFiles,
    }, { isAmend: command.isAmend, cap: deps.queueCap, now: input.now })
    queued++
  }

  const saved = await saveQueue(io, dataDir, { ...queue, lastSeen: { ...queue.lastSeen, [key]: head.sha } })
  return withNotice(saved.isSaved ? { queued, queue: saved.queue } : { queued })
}

// After a commit command ran: did HEAD move, and which new commits are worth a
// quiz? Never throws; any failure means nothing is queued.
export const detectCommits = async (deps: DetectDeps, input: DetectInput): Promise<DetectOutcome> => {
  try {
    return await detect(deps, input)
  } catch {
    return { queued: 0 }
  }
}
