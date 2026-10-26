// Decides whether a commit is worth a quiz, from `git show -w --numstat` output
// (whitespace-only changes count as 0) and its parent count. See SPEC behaviour 2.

export type Verdict =
  | { kind: 'queue'; codeLines: number; codeFiles: number }
  | { kind: 'trivial'; reason: 'merge' | 'docs-only' }
  | { kind: 'trivial'; reason: 'below-threshold'; codeLines: number }

const DOC_EXTENSIONS = /\.(md|mdx|txt|rst)$/i
const DOC_NAMES = /^(LICENSE|CHANGELOG)/i
const LOCKFILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'uv.lock', 'Cargo.lock', 'go.sum',
])

// `src/{a.ts => b.md}` and `old.txt => new.ts` are classified by the new path.
const newPath = (path: string): string =>
  path
    .replace(/\{[^{}]* => ([^{}]*)\}/g, '$1')
    .split(' => ')
    .at(-1)!
    .replace(/\/{2,}/g, '/')

export const isLockfile = (path: string): boolean => LOCKFILES.has(path.slice(path.lastIndexOf('/') + 1))

// Docs and lockfiles; the context pack uses the same test to order and omit files.
export const isNonCode = (path: string): boolean => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return (
    DOC_EXTENSIONS.test(name) ||
    DOC_NAMES.test(name) ||
    isLockfile(path) ||
    path.startsWith('docs/') ||
    path.includes('/docs/')
  )
}

export const classify = (numstat: string, parentCount: number, minChangedLines: number): Verdict => {
  if (parentCount >= 2) return { kind: 'trivial', reason: 'merge' }

  let files = 0
  let codeFiles = 0
  let codeLines = 0
  for (const line of numstat.split(/\r?\n/)) {
    const [added, deleted, ...rest] = line.split('\t')
    if (rest.length === 0) continue
    files++
    const isBinary = added === '-' || deleted === '-'
    if (isBinary || isNonCode(newPath(rest.join('\t')))) continue
    codeFiles++
    codeLines += Number(added) + Number(deleted)
  }

  if (files > 0 && codeFiles === 0) return { kind: 'trivial', reason: 'docs-only' }
  if (codeLines < minChangedLines) return { kind: 'trivial', reason: 'below-threshold', codeLines }
  return { kind: 'queue', codeLines, codeFiles }
}
