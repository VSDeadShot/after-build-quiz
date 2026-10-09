import { isAbsolute, toForwardSlashes } from './paths.ts'

// Spots a `git commit` inside a Bash or PowerShell command line. A false match
// costs nothing (detection only queues a HEAD that actually moved), so when in
// doubt this leans towards matching.

export type ParsedCommit = {
  isAmend: boolean
  dashC?: string // the `git -C <path>` of the commit, if any
  cdTarget?: string // the last cd / Set-Location before the commit, if any
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
  return dashC === undefined ? { isAmend } : { isAmend, dashC: toForwardSlashes(dashC) }
}

const cdTargetIn = (words: readonly string[]): string | undefined => {
  if (!CD.has((words[0] ?? '').toLowerCase())) return undefined
  const target = words.slice(1).find(word => !word.startsWith('-'))
  return target === undefined ? undefined : toForwardSlashes(target)
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
