import { describe, expect, test } from 'claude-code/testing'

import { git, GitRefused } from '../hooks/git.ts'
import type { Run } from '../hooks/git.ts'

const REPO = 'C:/scratch/repo'

const recordingGit = () => {
  const calls: (readonly string[])[] = []
  const run: Run = async argv => {
    calls.push(argv)
    return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  }
  return { run, calls }
}

describe('allowed read-only calls', () => {
  const cases: [string, readonly string[], readonly string[]][] = [
    ['rev-parse', ['rev-parse', '--show-toplevel'], ['rev-parse', '--show-toplevel']],
    ['log', ['log', '-1', '--format=%H'], ['log', '--no-ext-diff', '--no-textconv', '-1', '--format=%H']],
    ['show', ['show', '-w', '--numstat', 'abc123'], ['show', '--no-ext-diff', '--no-textconv', '-w', '--numstat', 'abc123']],
    ['cat-file', ['cat-file', '-e', 'abc123'], ['cat-file', '-e', 'abc123']],
    ['config --get', ['config', '--get', 'user.email'], ['config', '--get', 'user.email']],
  ]
  for (const [name, args, expected] of cases) {
    test(`${name} reaches git with exactly the expected argv`, async () => {
      const fake = recordingGit()
      await git(fake.run, REPO, args)
      expect(fake.calls).toEqual([['git', '-C', REPO, '--no-pager', ...expected]])
    })
  }

  test('log and show always carry --no-ext-diff and --no-textconv', async () => {
    const fake = recordingGit()
    await git(fake.run, REPO, ['log'])
    await git(fake.run, REPO, ['show', 'HEAD:src/a.ts'])
    for (const argv of fake.calls) {
      expect(argv).toContain('--no-ext-diff')
      expect(argv).toContain('--no-textconv')
    }
  })
})

describe('refused before anything runs', () => {
  const refused: [string, readonly string[]][] = [
    ['empty', []],
    ['commit', ['commit', '-m', 'x']],
    ['push', ['push', 'origin', 'main']],
    ['reset', ['reset', '--hard']],
    ['checkout', ['checkout', 'main']],
    ['config set', ['config', 'user.email', 'x@y.z']],
    ['config --unset', ['config', '--unset', 'user.email']],
    ['config --get with extra args', ['config', '--get', 'user.email', 'x']],
    ['-c before subcommand', ['-c', 'core.pager=evil', 'log']],
    ['--exec-path', ['--exec-path=/tmp', 'log']],
    ['--git-dir', ['--git-dir=elsewhere', 'log']],
    ['allowed name hidden in a later arg', ['push', 'log']],
    ['log --output=<file>', ['log', '--output=C:/x.txt']],
    ['log --output <file>', ['log', '--output', 'C:/x.txt']],
    ['show -o <file>', ['show', '-o', 'C:/x.txt']],
    ['show -o<file>', ['show', '-oC:/x.txt']],
    ['log --ext-diff', ['log', '-p', '--ext-diff']],
    ['show --textconv', ['show', '--textconv', 'abc123']],
    ['cat-file --textconv', ['cat-file', '--textconv', 'HEAD:a.ts']],
    ['cat-file --filters', ['cat-file', '--filters', 'HEAD:a.ts']],
  ]
  for (const [name, args] of refused) {
    test(name, async () => {
      const fake = recordingGit()
      let error: unknown
      try {
        await git(fake.run, REPO, args)
      } catch (caught) {
        error = caught
      }
      expect(error instanceof GitRefused).toBe(true)
      expect(fake.calls).toEqual([])
    })
  }
})
