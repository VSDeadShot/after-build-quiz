import { describe, expect, test } from 'claude-code/testing'

import { normalizeDir } from '../hooks/paths.ts'

describe('normalizeDir on Windows', () => {
  const rows: [string, string][] = [
    ['/c/Users/x', 'C:/Users/x'],
    ['/C/Users/x', 'C:/Users/x'],
    ['/c', 'C:/'],
    ['/c/', 'C:/'],
    ['/cygdrive/c/x', 'C:/x'],
    ['/cygdrive/D/x', 'D:/x'],
    ['C:\\Users\\x', 'C:/Users/x'],
    ['c:\\x\\', 'C:/x'],
    ['d:/x', 'D:/x'],
    ['C:\\', 'C:/'],
    ['sub', 'sub'],
    ['./sub', 'sub'],
    ['..\\up', '../up'],
    ['a\\b/c', 'a/b/c'],
  ]
  for (const [input, output] of rows) {
    test(`${input} → ${output}`, () => {
      expect(normalizeDir(input, true)).toBe(output)
    })
  }

  const unrecognised = [
    '/usr/bin', '/tmp/x', '/mnt/c/x', '/cygdrive', '/cygdrive/', '\\\\server\\share', '//server/share',
    '\\x', '~', '~/x', '$HOME/x', '${HOME}/x', '%USERPROFILE%\\x', 'C:', 'C:foo', '', '   ',
  ]
  for (const input of unrecognised) {
    test(`unrecognised: ${JSON.stringify(input)} → skip`, () => {
      expect(normalizeDir(input, true)).toBeUndefined()
    })
  }
})

describe('normalizeDir elsewhere', () => {
  test('POSIX absolute paths are kept', () => {
    expect(normalizeDir('/home/u/x', false)).toBe('/home/u/x')
    expect(normalizeDir('/home/u/x/', false)).toBe('/home/u/x')
    expect(normalizeDir('/', false)).toBe('/')
  })

  test('/c/x is a real path there, not a drive', () => {
    expect(normalizeDir('/c/x', false)).toBe('/c/x')
  })

  test('Windows drive paths and home shortcuts are skipped', () => {
    expect(normalizeDir('C:\\x', false)).toBeUndefined()
    expect(normalizeDir('~/x', false)).toBeUndefined()
    expect(normalizeDir('$HOME/x', false)).toBeUndefined()
  })

  test('relative paths stay relative', () => {
    expect(normalizeDir('./pkg', false)).toBe('pkg')
  })
})
