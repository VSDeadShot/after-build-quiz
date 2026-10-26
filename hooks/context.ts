import { git } from './git.ts'
import type { Run } from './git.ts'
import { COMMIT_FORMAT, parseCommitLine } from './queue.ts'
import type { QueueEntry } from './queue.ts'
import { isLockfile, isNonCode } from './trivial.ts'

// The context pack the question model and the grader read: built from the
// commit object alone (never the work tree), the same bytes every time for the
// same commit, so a resumed quiz rebuilds it instead of storing it. See SPEC
// behaviour 5. Nothing here throws into the user's workflow.

// `git show` options for the message and the diff; git.ts adds --no-ext-diff --no-textconv.
// Each one overrides a repo setting that would change the output (color, prefixes, context, signatures).
export const SHOW_COMMIT = [
  '--format=%B%x00', '--no-color', '--no-show-signature', '--find-renames', '-U5', '--src-prefix=a/', '--dst-prefix=b/',
] as const

const LIMITS = { message: 2_000, diff: 40_000, around: 20_000, doc: 8_000, subject: 200, line: 400 }
const WINDOW = 30 // lines of surrounding code on each side of a hunk
const AROUND_FILES = 5
const RECENT = 10
const DOCS = ['SPEC.md', 'AGENTS.md', 'README.md']

export type ContextPack = {
  text: string
  diffRefs: ReadonlySet<string> // `path:line` on diff lines: what a question may cite
  codeRefs: ReadonlySet<string> // diffRefs plus surrounding-code lines: what a grader gap may cite
  omitted: readonly string[]
}

export type PackResult = { isBuilt: true; pack: ContextPack } | { isBuilt: false; reason: string }

type Line = { kind: ' ' | '+' | '-'; oldLine: number; newLine: number; text: string }
type Hunk = { header: string; newStart: number; newCount: number; lines: Line[] }
type FileDiff = {
  path: string // new path; the old one for a deleted file
  oldPath: string
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  isBinary: boolean
  isSubmodule: boolean
  hunks: Hunk[]
  added: number
  deleted: number
}

// Secret files never enter the pack, matched by name under the old or the new path.
const isSecret = (path: string): boolean => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return /^\.env/i.test(name) || /\.(pem|key)$/i.test(name)
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

// git's C-style quoting (core.quotePath): octal bytes of UTF-8 and backslash escapes.
const unquote = (value: string): string => {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  const body = [...value.slice(1, -1)]
  let encoded = ''
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== '\\') {
      encoded += encodeURIComponent(char)
      continue
    }
    const next = body[i + 1] ?? ''
    if (/[0-7]/.test(next)) {
      const octal = body.slice(i + 1, i + 4).join('')
      encoded += `%${parseInt(octal, 8).toString(16).padStart(2, '0')}`
      i += octal.length
    } else {
      encoded += `%${(ESCAPES[next] ?? next.charCodeAt(0)).toString(16).padStart(2, '0')}`
      i += 1
    }
  }
  try {
    return decodeURIComponent(encoded)
  } catch {
    return value // not UTF-8: keep git's spelling
  }
}

const withoutPrefix = (path: string, prefix: string) => (path.startsWith(prefix) ? path.slice(prefix.length) : path)

// `--- a/x` / `+++ b/x`: git ends the line with a tab when the name has a space.
const sidePath = (line: string, prefix: string): string | undefined => {
  const value = line.slice(4).replace(/\t$/, '')
  return value === '/dev/null' ? undefined : withoutPrefix(unquote(value), prefix)
}

// `diff --git a/x b/x`, for a file with no ---/+++ lines (binary, pure rename, mode change).
const gitLinePath = (line: string): string => {
  const rest = line.slice('diff --git '.length)
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$/.exec(rest)
  if (rest.startsWith('"') || quoted !== null) {
    const second = quoted?.[2] ?? rest.slice(rest.lastIndexOf(' "') + 1)
    return withoutPrefix(unquote(second), 'b/')
  }
  const half = (rest.length - 5) / 2 // `a/X b/X`: both halves the same when the path did not change
  if (Number.isInteger(half) && rest.startsWith('a/') && rest.slice(2, 2 + half) === rest.slice(5 + half)) {
    return rest.slice(5 + half)
  }
  return withoutPrefix(rest.slice(rest.lastIndexOf(' b/') + 1), 'b/')
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

const parseFile = (block: string[]): FileDiff => {
  let minus: string | undefined
  let plus: string | undefined
  let renameFrom: string | undefined
  let renameTo: string | undefined
  let status: FileDiff['status'] = 'modified'
  let isBinary = false
  let isSubmodule = false
  const hunks: Hunk[] = []
  let current: Hunk | undefined
  let oldLeft = 0
  let newLeft = 0
  let oldLine = 0
  let newLine = 0

  for (const raw of block.slice(1)) {
    const line = raw.replace(/\r$/, '')
    const header = HUNK.exec(line)
    if (header !== null) {
      oldLine = Number(header[1])
      oldLeft = header[2] === undefined ? 1 : Number(header[2])
      newLine = Number(header[3])
      newLeft = header[4] === undefined ? 1 : Number(header[4])
      current = { header: line, newStart: newLine, newCount: newLeft, lines: [] }
      hunks.push(current)
      continue
    }
    if (current !== undefined && (oldLeft > 0 || newLeft > 0)) {
      const kind = line[0] ?? ' ' // an empty line is an empty context line (diff.suppressBlankEmpty)
      if (kind === '\\') continue // \ No newline at end of file
      const text = line.slice(1)
      if (kind === '+') {
        current.lines.push({ kind, oldLine: 0, newLine: newLine++, text })
        newLeft--
      } else if (kind === '-') {
        current.lines.push({ kind, oldLine: oldLine++, newLine: 0, text })
        oldLeft--
      } else {
        current.lines.push({ kind: ' ', oldLine: oldLine++, newLine: newLine++, text })
        oldLeft--
        newLeft--
      }
      continue
    }
    if (current !== undefined) continue
    if (line.startsWith('new file mode')) status = 'added'
    else if (line.startsWith('deleted file mode')) status = 'deleted'
    else if (line.startsWith('rename from ')) renameFrom = unquote(line.slice('rename from '.length))
    else if (line.startsWith('rename to ')) renameTo = unquote(line.slice('rename to '.length))
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') isBinary = true
    else if (line.startsWith('--- ')) minus = sidePath(line, 'a/')
    else if (line.startsWith('+++ ')) plus = sidePath(line, 'b/')
    if (/^(index \S+ |new file mode |deleted file mode )160000$/.test(line)) isSubmodule = true
  }

  const fallback = gitLinePath(block[0]!.replace(/\r$/, ''))
  const newPath = renameTo ?? plus ?? minus ?? fallback
  const oldPath = renameFrom ?? minus ?? newPath
  if (renameFrom !== undefined && status === 'modified') status = 'renamed'
  const lines = hunks.flatMap(h => h.lines)
  return {
    path: status === 'deleted' ? oldPath : newPath,
    oldPath,
    status,
    isBinary,
    isSubmodule,
    hunks,
    added: lines.filter(l => l.kind === '+').length,
    deleted: lines.filter(l => l.kind === '-').length,
  }
}

const parseDiff = (diff: string): FileDiff[] => {
  const blocks: string[][] = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) blocks.push([line])
    else blocks.at(-1)?.push(line)
  }
  return blocks.map(parseFile)
}

const cut = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text)
const pad = (n: number) => String(n).padStart(5)

const byChange = (a: FileDiff, b: FileDiff) =>
  b.added + b.deleted - (a.added + a.deleted) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

const label = (file: FileDiff) => {
  const counts = `+${file.added} -${file.deleted}`
  if (file.status === 'deleted') return `deleted; line numbers from the parent, ${counts}`
  if (file.status === 'renamed') return `renamed from ${file.oldPath}, ${counts}`
  return `${file.status}, ${counts}`
}

const renderLine = (file: FileDiff, line: Line) => {
  const text = cut(line.text, LIMITS.line)
  if (line.kind === '-') return `${file.status === 'deleted' ? pad(line.oldLine) : ' '.repeat(5)} - ${text}`
  return `${pad(line.newLine)} ${line.kind} ${text}`
}

const lineRef = (file: FileDiff, line: Line): string | undefined => {
  if (line.kind !== '-') return `${file.path}:${line.newLine}`
  return file.status === 'deleted' ? `${file.path}:${line.oldLine}` : undefined
}

type Shown = { file: FileDiff; hunks: Hunk[] }

const renderDiff = (files: FileDiff[], refs: Set<string>, omitted: string[]) => {
  const out: string[] = []
  const shown: Shown[] = []
  const notShown: string[] = []
  let used = 0
  for (const file of files) {
    const header = `=== ${file.path} (${label(file)})`
    if (used + header.length + 1 > LIMITS.diff) {
      notShown.push(file.path)
      continue
    }
    out.push(header)
    used += header.length + 1
    const kept: Hunk[] = []
    let left = 0
    for (const hunk of file.hunks) {
      const block = [cut(hunk.header, LIMITS.line), ...hunk.lines.map(line => renderLine(file, line))].join('\n')
      if (left === 0 && used + block.length + 1 <= LIMITS.diff) {
        out.push(block)
        used += block.length + 1
        kept.push(hunk)
        for (const line of hunk.lines) {
          const ref = lineRef(file, line)
          if (ref !== undefined) refs.add(ref)
        }
      } else {
        left++
      }
    }
    if (left > 0) {
      out.push(`(${left} more hunks omitted)`)
      omitted.push(`${file.path}: ${left} hunks omitted (size limit)`)
    }
    shown.push({ file, hunks: kept })
  }
  if (notShown.length > 0) {
    out.push(`(${notShown.length} more files omitted: ${notShown.join(', ')})`)
    omitted.push(`diff: ${notShown.length} files omitted (size limit): ${notShown.join(', ')}`)
  }
  return { text: out.join('\n'), shown }
}

const linesOf = (text: string) => {
  const lines = text.split('\n').map(line => line.replace(/\r$/, ''))
  if (lines.at(-1) === '') lines.pop()
  return lines
}

// ±WINDOW lines around each shown hunk, merged, clamped, skipping lines the diff already shows.
const windowsOf = (hunks: Hunk[], length: number) => {
  const spans = hunks
    .map(h => [Math.max(1, h.newStart - WINDOW), Math.min(length, h.newStart + Math.max(h.newCount, 1) - 1 + WINDOW)] as const)
    .sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [start, end] of spans) {
    const last = merged.at(-1)
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

const renderAround = async (
  run: Run, top: string, sha: string, shown: Shown[], refs: Set<string>, omitted: string[],
) => {
  const candidates = shown
    .filter(({ file, hunks }) => hunks.length > 0 && file.status !== 'deleted' && !isNonCode(file.path))
    .slice(0, AROUND_FILES)
  const out: string[] = []
  let used = 0
  for (const { file, hunks } of candidates) {
    const blob = await readBlob(run, top, `${sha}:${file.path}`)
    if (blob === undefined) {
      omitted.push(`${file.path}: surrounding code unavailable`)
      continue
    }
    const lines = linesOf(blob)
    const inDiff = new Set(hunks.flatMap(h => h.lines.filter(l => l.kind !== '-').map(l => l.newLine)))
    const block: { text: string; ref?: string }[] = []
    for (const [start, end] of windowsOf(hunks, lines.length)) {
      let isGap = block.length > 0
      for (let n = start; n <= end; n++) {
        if (inDiff.has(n)) {
          isGap = true
          continue
        }
        if (isGap && block.length > 0) block.push({ text: '      …' })
        isGap = false
        block.push({ text: `${pad(n)} | ${cut(lines[n - 1] ?? '', LIMITS.line)}`, ref: `${file.path}:${n}` })
      }
    }
    if (block.length === 0) continue
    for (const { text, ref } of [{ text: `=== ${file.path}` }, ...block]) {
      if (used + text.length + 1 > LIMITS.around) {
        out.push('[… surrounding code cut at the size limit]')
        omitted.push('surrounding code: cut at the size limit')
        return out.join('\n')
      }
      used += text.length + 1
      out.push(text)
      if (ref !== undefined) refs.add(ref)
    }
  }
  return out.join('\n')
}

const readBlob = async (run: Run, top: string, object: string): Promise<string | undefined> => {
  try {
    const result = await git(run, top, ['cat-file', 'blob', object])
    return result.exitCode === 0 && !result.isStdoutTruncated ? result.stdout : undefined
  } catch {
    return undefined
  }
}

const capped = (text: string, limit: number, name: string, omitted: string[]) => {
  if (text.length <= limit) return text
  omitted.push(`${name}: ${text.length - limit} characters omitted`)
  return `${text.slice(0, limit)}\n[… ${text.length - limit} more characters omitted]`
}

const recentSubjects = async (run: Run, top: string, sha: string): Promise<string[]> => {
  try {
    const result = await git(run, top, ['log', '--no-merges', '-n', String(RECENT + 1), `--format=${COMMIT_FORMAT}`, sha])
    if (result.exitCode !== 0) return []
    return result.stdout
      .split(/\r?\n/)
      .flatMap(line => parseCommitLine(line) ?? [])
      .filter(made => made.hash !== sha)
      .slice(0, RECENT)
      .map(made => cut(made.subject, LIMITS.subject))
  } catch {
    return []
  }
}

export const buildContextPack = async (
  run: Run,
  entry: Pick<QueueEntry, 'repo' | 'repoName' | 'hash'>,
): Promise<PackResult> => {
  try {
    const sha = entry.hash
    const shown = await git(run, entry.repo, ['show', ...SHOW_COMMIT, sha])
    if (shown.exitCode !== 0) {
      return { isBuilt: false, reason: `git show failed: ${shown.stderr.split(/\r?\n/)[0] ?? ''}`.trim() }
    }
    const split = shown.stdout.indexOf('\x00')
    const message = (split === -1 ? '' : shown.stdout.slice(0, split)).replace(/\r/g, '').trimEnd()
    const diff = split === -1 ? shown.stdout : shown.stdout.slice(split + 1).replace(/^\r?\n+/, '')

    const omitted: string[] = []
    const diffRefs = new Set<string>()
    const quizzable: FileDiff[] = []
    const messageText = capped(message, LIMITS.message, 'commit message', omitted)
    if (shown.isStdoutTruncated) omitted.push('diff: the end was cut by the process output limit')
    for (const file of parseDiff(diff)) {
      if (isSecret(file.path) || isSecret(file.oldPath)) omitted.push(`${file.path}: secret file, omitted`)
      else if (file.isSubmodule) omitted.push(`${file.path}: submodule, omitted`)
      else if (file.isBinary) omitted.push(`${file.path}: binary, omitted`)
      else if (isLockfile(file.path)) omitted.push(`${file.path}: lockfile, omitted`)
      else quizzable.push(file)
    }
    const ordered = [
      ...quizzable.filter(file => !isNonCode(file.path)).sort(byChange),
      ...quizzable.filter(file => isNonCode(file.path)).sort(byChange),
    ]
    const renderedDiff = renderDiff(ordered, diffRefs, omitted)

    const subjects = await recentSubjects(run, entry.repo, sha)
    const codeRefs = new Set(diffRefs)
    const around = await renderAround(run, entry.repo, sha, renderedDiff.shown, codeRefs, omitted)

    const docs: string[] = []
    for (const name of DOCS) {
      const content = await readBlob(run, entry.repo, `${sha}:${name}`)
      if (content === undefined) continue
      docs.push(`### ${name}\n${capped(linesOf(content).join('\n'), LIMITS.doc, name, omitted)}`)
    }

    const text = [
      `# Commit ${sha.slice(0, 7)} in ${entry.repoName}`,
      `## Commit message\n${messageText || '(empty)'}`,
      `## Recent commits (newest first)\n${subjects.length === 0 ? '(none)' : subjects.map(s => `- ${s}`).join('\n')}`,
      '## Diff\nLine numbers are the file\'s lines after this commit; a deleted file\'s are from before it. ' +
        `"+" added, "-" removed.\n\n${renderedDiff.text || '(no text changes)'}`,
      `## Surrounding code at this commit\n${around || '(none)'}`,
      `## Repo docs at this commit\n${docs.length === 0 ? '(none)' : docs.join('\n\n')}`,
      `## Omitted\n${omitted.length === 0 ? '(none)' : omitted.map(line => `- ${line}`).join('\n')}`,
    ].join('\n\n')
    return { isBuilt: true, pack: { text: `${text}\n`, diffRefs, codeRefs, omitted } }
  } catch (error) {
    return { isBuilt: false, reason: String(error) }
  }
}
