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

// A line that looks like a secret is replaced whole, never in place: a partial
// match could leave the rest of a secret behind (the approach of second-brain's
// git_history.py). Lines are matched in full, before the display cut, and a
// redacted line is never citable.
export const REDACTED = '[line redacted: possible secret]'

// Run-together names that are one word to the 4b split but a secret name to a person: apikey,
// clientsecret. A fixed list, not prefix + secret word, so monkey, turkey and hockey stay clean.
const COMPOUND = 'apikey|apisecret|apitoken|secretkey|accesskey|privatekey|authkey|signingkey|encryptionkey|' +
  'masterkey|authtoken|accesstoken|refreshtoken|sessiontoken|bearertoken|clientsecret|appsecret|' +
  'consumersecret|webhooksecret'
const COMPOUND_NAME = new RegExp(`^(?:${COMPOUND})$`, 'i')

const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_\-]{35}/, // Google API key
  /\bsk-[A-Za-z0-9_\-]{20,}/, // OpenAI, Anthropic
  /BEGIN [A-Z0-9 ]*KEY/, // private key header; secretMask takes the whole block
  // env/ini line: an upper-case name ending in a secret word (then optional _PARTs) set to 8+ characters
  /^\s*(?:export\s+)?[A-Z0-9_]{0,64}(?:KEY|SECRET|PASSWORD|PASSWD|TOKEN)(?:_[A-Z0-9]+)*\s*=\s*["']?[^\s"']{8,}/,
  // env line, any case: a compound name (after optional word_ / word- parts) set to an unquoted or quoted
  // 8+ character value running to the end of the line; `.` and `()` keep `apikey = process.env.X` clean
  new RegExp(`^\\s*(?:export\\s+)?(?:[A-Za-z0-9]+[_-])*(?:${COMPOUND})\\s*=(?!=)\\s*["']?[A-Za-z0-9_\\-+/=~]{8,}["']?\\s*(?:#.*)?$`, 'i'),
  /\b[a-z][a-z0-9+.\-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, // credentials in a URL
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/, // bcrypt hash
  /\b(?:gh[po]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/, // GitHub
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key ID
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\b[rs]k_live_[A-Za-z0-9]{10,}/, // Stripe
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/, // JWT, incl. Supabase anon/service_role keys
  /\bsb_secret_[A-Za-z0-9_\-]{10,}/, // Supabase secret key
]

// A quoted literal of 8+ non-space characters assigned to a secret-looking name, anywhere:
// `apiKey: "…"`, `password = '…'`, `"token": "…"`, `api_key="…"`, `token := "…"`.
const ASSIGNED = /(?<![\w$-])["']?([A-Za-z_$][\w$-]*)["']?\s*(?::=|[:=])\s*(["'`])((?:(?!\2)\S){8,})\2/g
const UPPER_NAME = /^[A-Z0-9_]*(?:KEY|SECRET|PASSWORD|PASSWD|TOKEN)(?:_[A-Z0-9]+)*$/
const SECRET_WORD = /^(?:key|secret|password|passwd|token)$/i

// API_KEY, SECRET_KEY_BASE (as 4a); otherwise the last word must be one, or a compound: apiKey, client_secret,
// x-api-key, apikey, openai_apikey (not keyPrefix, secretFiles, monkey, apikeyPrefix).
const isSecretName = (name: string) => {
  const last = name.split(/[_$-]|(?<=[a-z0-9])(?=[A-Z])/).at(-1) ?? ''
  return UPPER_NAME.test(name) || SECRET_WORD.test(last) || COMPOUND_NAME.test(last)
}

// 10: a Bearer token of 16+ characters, with or without an Authorization name on the line (bare header,
// JSON header, curl -H). An obvious placeholder is not a secret: <token>, $TOKEN, ${TOKEN}, {{token}},
// {token}, YOUR_TOKEN, all x's (xxxx-xxxx), or a bare ellipsis.
const BEARER = /\bbearer\s+([^\s"'`,;)]{16,})/gi
const PLACEHOLDER = /^(?:[<${]|your[_-]|x+(?:[-_.]x+)*$|(?:\.\.\.|…)$)/i

// matchAll works on a copy of BEARER, so no lastIndex carries over between calls.
const hasBearerToken = (line: string) => [...line.matchAll(BEARER)].some(match => !PLACEHOLDER.test(match[1]!))

export const isSecretLine = (line: string): boolean =>
  SECRET_PATTERNS.some(pattern => pattern.test(line)) ||
  [...line.matchAll(ASSIGNED)].some(match => isSecretName(match[1]!)) ||
  hasBearerToken(line)

const BLOCK_BEGIN = /-----BEGIN [A-Z0-9 ]*KEY[A-Z0-9 ]*-----/
const BLOCK_END = /-----END [A-Z0-9 ]*KEY[A-Z0-9 ]*-----/

// Which lines to redact: each secret-looking line, and every line of a key block. A part
// (one hunk) can hold part of a block: a BEGIN with no END runs to the part's end, an END
// with no BEGIN back to its start.
export const secretMask = (lines: readonly string[]): boolean[] => {
  const mask = lines.map(isSecretLine)
  let open: number | undefined
  let from = 0
  lines.forEach((line, i) => {
    if (open === undefined && BLOCK_BEGIN.test(line)) open = i
    if (BLOCK_END.test(line)) {
      mask.fill(true, open ?? from, i + 1)
      open = undefined
      from = i + 1
    }
  })
  if (open !== undefined) mask.fill(true, open)
  return mask
}

// Redacted-line counts by place (a path, `commit message`, `recent commits`, a doc), in first-seen order.
type Redactions = Map<string, number>
const note = (redactions: Redactions, place: string, count: number) => {
  if (count > 0) redactions.set(place, (redactions.get(place) ?? 0) + count)
}
const redactedEntries = (redactions: Redactions) =>
  [...redactions].map(([place, n]) => `${place}: ${n} ${n === 1 ? 'line' : 'lines'} redacted (possible secret)`)

// Whole text (a message, a doc): secret lines replaced, blocks found over all of it.
const redactText = (lines: readonly string[], place: string, redactions: Redactions) => {
  const mask = secretMask(lines)
  note(redactions, place, mask.filter(Boolean).length)
  return lines.map((line, i) => (mask[i] ? REDACTED : line)).join('\n')
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

const renderLine = (file: FileDiff, line: Line, isRedacted: boolean) => {
  const text = isRedacted ? REDACTED : cut(line.text, LIMITS.line)
  if (line.kind === '-') return `${file.status === 'deleted' ? pad(line.oldLine) : ' '.repeat(5)} - ${text}`
  return `${pad(line.newLine)} ${line.kind} ${text}`
}

const lineRef = (file: FileDiff, line: Line): string | undefined => {
  if (line.kind !== '-') return `${file.path}:${line.newLine}`
  return file.status === 'deleted' ? `${file.path}:${line.oldLine}` : undefined
}

type Shown = { file: FileDiff; hunks: Hunk[] }

// `@@ -a,b +c,d @@ <label>`: a label that looks like a secret is replaced.
const renderHeader = (header: string) => {
  const ranges = HUNK.exec(header)?.[0] ?? ''
  const isRedacted = isSecretLine(header.slice(ranges.length))
  return { text: isRedacted ? `${ranges} ${REDACTED}` : cut(header, LIMITS.line), isRedacted }
}

const renderDiff = (files: FileDiff[], refs: Set<string>, omitted: string[], redactions: Redactions) => {
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
      const header = renderHeader(hunk.header)
      const mask = secretMask(hunk.lines.map(line => line.text))
      const block = [header.text, ...hunk.lines.map((line, i) => renderLine(file, line, mask[i]!))].join('\n')
      if (left === 0 && used + block.length + 1 <= LIMITS.diff) {
        out.push(block)
        used += block.length + 1
        kept.push(hunk)
        hunk.lines.forEach((line, i) => {
          const ref = mask[i] ? undefined : lineRef(file, line)
          if (ref !== undefined) refs.add(ref)
        })
        note(redactions, file.path, mask.filter(Boolean).length + (header.isRedacted ? 1 : 0))
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
  run: Run, top: string, sha: string, shown: Shown[], refs: Set<string>, omitted: string[], redactions: Redactions,
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
    const mask = secretMask(lines) // over the whole blob, so a block is found exactly
    const inDiff = new Set(hunks.flatMap(h => h.lines.filter(l => l.kind !== '-').map(l => l.newLine)))
    const block: { text: string; ref?: string; isRedacted?: boolean }[] = []
    for (const [start, end] of windowsOf(hunks, lines.length)) {
      let isGap = block.length > 0
      for (let n = start; n <= end; n++) {
        if (inDiff.has(n)) {
          isGap = true
          continue
        }
        if (isGap && block.length > 0) block.push({ text: '      …' })
        isGap = false
        block.push(mask[n - 1]
          ? { text: `${pad(n)} | ${REDACTED}`, isRedacted: true }
          : { text: `${pad(n)} | ${cut(lines[n - 1] ?? '', LIMITS.line)}`, ref: `${file.path}:${n}` })
      }
    }
    if (block.length === 0) continue
    for (const { text, ref, isRedacted } of [{ text: `=== ${file.path}` }, ...block]) {
      if (used + text.length + 1 > LIMITS.around) {
        out.push('[… surrounding code cut at the size limit]')
        omitted.push('surrounding code: cut at the size limit')
        return out.join('\n')
      }
      used += text.length + 1
      out.push(text)
      if (ref !== undefined) refs.add(ref)
      if (isRedacted === true) note(redactions, file.path, 1)
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
      .map(made => made.subject)
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
    const redactions: Redactions = new Map()
    const diffRefs = new Set<string>()
    const quizzable: FileDiff[] = []
    const messageText = capped(redactText(message.split('\n'), 'commit message', redactions), LIMITS.message, 'commit message', omitted)
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
    const renderedDiff = renderDiff(ordered, diffRefs, omitted, redactions)

    const subjects = (await recentSubjects(run, entry.repo, sha)).map(subject => {
      if (!isSecretLine(subject)) return cut(subject, LIMITS.subject)
      note(redactions, 'recent commits', 1)
      return REDACTED
    })
    const codeRefs = new Set(diffRefs)
    const around = await renderAround(run, entry.repo, sha, renderedDiff.shown, codeRefs, omitted, redactions)

    const docs: string[] = []
    for (const name of DOCS) {
      const content = await readBlob(run, entry.repo, `${sha}:${name}`)
      if (content === undefined) continue
      docs.push(`### ${name}\n${capped(redactText(linesOf(content), name, redactions), LIMITS.doc, name, omitted)}`)
    }
    omitted.push(...redactedEntries(redactions))

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
