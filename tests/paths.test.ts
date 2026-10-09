import { describe, expect, test } from 'claude-code/testing'

import { checkDataDir, resolveDataDir } from '../hooks/paths.ts'
import type { Run } from '../hooks/git.ts'
import type { Exists } from '../hooks/paths.ts'

const ok = (stdout: string) => ({
  exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
})
const notARepo = {
  exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false,
}

const fakeGit = (answer: (argv: readonly string[]) => ReturnType<typeof ok>) => {
  const calls: (readonly string[])[] = []
  const run: Run = async argv => {
    calls.push(argv)
    return answer(argv)
  }
  return { run, calls }
}

const existing = (...paths: string[]): Exists => async path => paths.includes(path)

describe('resolveDataDir', () => {
  test('uses USERPROFILE with forward slashes', () => {
    expect(resolveDataDir('', { USERPROFILE: 'C:\\Users\\someone' })).toBe('C:/Users/someone/.after-build-quiz')
  })

  test('falls back to HOME', () => {
    expect(resolveDataDir('', { HOME: '/home/someone/' })).toBe('/home/someone/.after-build-quiz')
  })

  test('the setting overrides both', () => {
    expect(resolveDataDir('D:\\quiz-data\\', { USERPROFILE: 'C:\\Users\\someone', HOME: '/h' })).toBe('D:/quiz-data')
  })

  test('throws when neither variable is set', () => {
    expect(() => resolveDataDir('', {})).toThrow()
  })

  test('rejects a relative setting (it would land in the session repo)', () => {
    expect(() => resolveDataDir('quiz-data', { USERPROFILE: 'C:\\Users\\someone' })).toThrow()
    expect(() => resolveDataDir('.\\quiz', { USERPROFILE: 'C:\\Users\\someone' })).toThrow()
  })
})

describe('checkDataDir', () => {
  test('refuses a folder inside a git work tree', async () => {
    const git = fakeGit(() => ok('true\n'))
    const verdict = await checkDataDir('C:/repo/data', { run: git.run, exists: existing('C:/repo/data') })
    expect(verdict.isSafe).toBe(false)
    expect(git.calls).toEqual([['git', '-C', 'C:/repo/data', '--no-pager', 'rev-parse', '--is-inside-work-tree']])
  })

  test('accepts a folder that is not in a repo', async () => {
    const git = fakeGit(() => notARepo)
    const verdict = await checkDataDir('C:/Users/someone/.after-build-quiz', {
      run: git.run, exists: existing('C:/Users/someone/.after-build-quiz'),
    })
    expect(verdict.isSafe).toBe(true)
  })

  test('accepts a .git folder answer of "false"', async () => {
    const git = fakeGit(() => ok('false\n'))
    const verdict = await checkDataDir('C:/x', { run: git.run, exists: existing('C:/x') })
    expect(verdict.isSafe).toBe(true)
  })

  test('checks the nearest existing parent when the folder does not exist yet', async () => {
    const git = fakeGit(() => ok('true\n'))
    const verdict = await checkDataDir('C:/repo/new/deeper', { run: git.run, exists: existing('C:/repo') })
    expect(verdict.isSafe).toBe(false)
    expect(git.calls).toEqual([['git', '-C', 'C:/repo', '--no-pager', 'rev-parse', '--is-inside-work-tree']])
  })

  test('refuses when git cannot be run (cannot verify)', async () => {
    const run: Run = async () => {
      throw new Error('spawn git ENOENT')
    }
    const verdict = await checkDataDir('C:/x', { run, exists: existing('C:/x') })
    expect(verdict.isSafe).toBe(false)
  })

  test('refuses when no parent exists at all', async () => {
    const git = fakeGit(() => notARepo)
    const verdict = await checkDataDir('Q:/nowhere/data', { run: git.run, exists: existing() })
    expect(verdict.isSafe).toBe(false)
    expect(git.calls).toEqual([])
  })
})
