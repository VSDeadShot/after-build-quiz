import { describe, expect, test } from 'claude-code/testing'

import { classify } from '../hooks/trivial.ts'

const numstat = (...rows: [string, string, string][]) => rows.map(row => row.join('\t')).join('\n') + '\n'

describe('classify', () => {
  test('a merge commit is trivial whatever it changed', () => {
    const verdict = classify(numstat(['400', '20', 'src/big.ts']), 2, 10)
    expect(verdict).toEqual({ kind: 'trivial', reason: 'merge' })
  })

  test('docs-only is trivial', () => {
    const verdict = classify(numstat(
      ['120', '4', 'README.md'],
      ['30', '0', 'docs/guide/setup.txt'],
      ['5', '5', 'CHANGELOG'],
      ['1', '1', 'LICENSE-MIT'],
      ['3', '0', 'notes/design.mdx'],
      ['9', '2', 'api/reference.rst'],
    ), 1, 10)
    expect(verdict).toEqual({ kind: 'trivial', reason: 'docs-only' })
  })

  test('lockfiles and binaries alone are trivial', () => {
    const verdict = classify(numstat(
      ['900', '850', 'package-lock.json'],
      ['40', '12', 'web/pnpm-lock.yaml'],
      ['-', '-', 'assets/logo.png'],
      ['2', '2', 'go.sum'],
    ), 1, 10)
    expect(verdict).toEqual({ kind: 'trivial', reason: 'docs-only' })
  })

  test('9 changed code lines is below the threshold', () => {
    const verdict = classify(numstat(['6', '3', 'src/a.ts'], ['200', '0', 'README.md']), 1, 10)
    expect(verdict).toEqual({ kind: 'trivial', reason: 'below-threshold', codeLines: 9 })
  })

  test('10 changed code lines is queued, docs and lockfiles not counted', () => {
    const verdict = classify(numstat(
      ['7', '1', 'src/a.ts'],
      ['1', '1', 'src/b.py'],
      ['300', '0', 'package-lock.json'],
      ['50', '0', 'docs/x.md'],
    ), 1, 10)
    expect(verdict).toEqual({ kind: 'queue', codeLines: 10, codeFiles: 2 })
  })

  test('config files count as code', () => {
    const verdict = classify(numstat(['8', '4', '.github/workflows/ci.yml'], ['3', '0', 'tsconfig.json']), 1, 10)
    expect(verdict).toEqual({ kind: 'queue', codeLines: 15, codeFiles: 2 })
  })

  test('whitespace-only changes (0 0 under -w) are below the threshold', () => {
    const verdict = classify(numstat(['0', '0', 'src/a.ts'], ['0', '0', 'src/b.ts']), 1, 10)
    expect(verdict).toEqual({ kind: 'trivial', reason: 'below-threshold', codeLines: 0 })
  })

  test('an empty commit is below the threshold', () => {
    expect(classify('', 1, 10)).toEqual({ kind: 'trivial', reason: 'below-threshold', codeLines: 0 })
  })

  test('renames are classified by their new path', () => {
    const toDocs = classify(numstat(['20', '0', 'src/{notes.ts => notes.md}']), 1, 10)
    expect(toDocs).toEqual({ kind: 'trivial', reason: 'docs-only' })
    const toCode = classify(numstat(['20', '0', 'old/readme.txt => src/main.ts']), 1, 10)
    expect(toCode).toEqual({ kind: 'queue', codeLines: 20, codeFiles: 1 })
  })

  test('CRLF output and a root commit (0 parents) are handled', () => {
    const verdict = classify('12\t0\tsrc/a.ts\r\n', 0, 10)
    expect(verdict).toEqual({ kind: 'queue', codeLines: 12, codeFiles: 1 })
  })

  test('the threshold comes from the setting', () => {
    expect(classify(numstat(['3', '0', 'src/a.ts']), 1, 3)).toEqual({ kind: 'queue', codeLines: 3, codeFiles: 1 })
    expect(classify(numstat(['0', '0', 'src/a.ts']), 1, 0)).toEqual({ kind: 'queue', codeLines: 0, codeFiles: 1 })
  })
})
