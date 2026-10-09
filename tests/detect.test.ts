import { describe, expect, test } from 'claude-code/testing'

import { parseCommit, repoCandidates } from '../hooks/detect.ts'

describe('parseCommit: commit commands', () => {
  const commits: [string, string][] = [
    ['plain', 'git commit -m "x"'],
    ['-C with spaces', 'git -C "C:/a b/repo" commit -m x'],
    ['after cd &&', 'cd /c/repo && git add a.ts && git commit -m "x"'],
    ['after ;', 'git add src/a.ts; git commit -am "wip"'],
    ['amend', 'git commit --amend --no-edit'],
    ['PowerShell here-string', "git commit -m @'\nfix: don't break \"quotes\"\n'@"],
    ['Claude-style $(cat <<EOF)', "git commit -m \"$(cat <<'EOF'\nAdd x\n\nIt's done\nEOF\n)\""],
    ['bash heredoc on stdin', "git commit -F - <<'EOF'\ndon't\nEOF"],
    ['PowerShell call operator', '& git commit -m x'],
    ['git.exe', 'git.exe commit -m x'],
    ['env prefix', 'GIT_AUTHOR_DATE=2020-01-01 git commit -m x'],
    ['-c option', 'git -c user.name=x commit -m y'],
    ['--no-pager', 'git --no-pager commit -m x'],
    ['after Set-Location ;', 'Set-Location "C:\\r"; git commit -m x'],
    ['after a test run', 'npm test && git commit -m "x"'],
    ['PowerShell chain', 'git add hooks/a.ts; if ($?) { git commit -m "x" }'],
  ]
  for (const [name, cmd] of commits) {
    test(name, () => {
      expect(parseCommit(cmd)).toBeDefined()
    })
  }
})

describe('parseCommit: not commit commands', () => {
  const others: [string, string][] = [
    ['log --grep commit', 'git log --grep commit'],
    ['echo', 'echo "git commit"'],
    ['grep for it', 'grep -r "git commit" .'],
    ['status', 'git status'],
    ['commit-tree', 'git commit-tree abc123'],
    ['gitk', 'gitk commit'],
    ['alias definition', 'git config alias.ci commit'],
    ['quoted in a message of another command', 'git tag -m "git commit" v1'],
    ['empty', ''],
  ]
  for (const [name, cmd] of others) {
    test(name, () => {
      expect(parseCommit(cmd)).toBeUndefined()
    })
  }
})

describe('parseCommit: details', () => {
  test('--amend is seen', () => {
    expect(parseCommit('git commit --amend -m x')?.isAmend).toBe(true)
    expect(parseCommit('git commit -m x')?.isAmend).toBe(false)
  })

  test('a message that says --amend is not an amend', () => {
    expect(parseCommit('git commit -m "--amend"')?.isAmend).toBe(false)
  })

  test('-C path is captured, quotes removed, slashes forward', () => {
    expect(parseCommit('git -C "C:\\a b\\repo" commit -m x')?.dashC).toBe('C:/a b/repo')
  })

  test('the last cd before the commit is captured', () => {
    expect(parseCommit('cd /c/one && cd /c/two && git commit -m x')?.cdTarget).toBe('/c/two')
    expect(parseCommit('Set-Location "C:\\r"; git commit -m x')?.cdTarget).toBe('C:/r')
    expect(parseCommit('git commit -m x')?.cdTarget).toBeUndefined()
  })
})

describe('repoCandidates', () => {
  test('-C relative to the tracked shell directory comes first', () => {
    const parsed = parseCommit('git -C sub commit -m x')!
    expect(repoCandidates(parsed, 'C:/w', 'C:/session')).toEqual(['C:/w/sub', 'C:/w', 'C:/session'])
  })

  test('absolute -C is used as is', () => {
    const parsed = parseCommit('git -C D:/repo commit -m x')!
    expect(repoCandidates(parsed, 'C:/w', 'C:/session')).toEqual(['D:/repo', 'C:/w', 'C:/session'])
  })

  test('cd target beats the tracked directory', () => {
    const parsed = parseCommit('cd C:/other && git commit -m x')!
    expect(repoCandidates(parsed, 'C:/w', 'C:/session')).toEqual(['C:/other', 'C:/w', 'C:/session'])
  })

  test('relative cd resolves against the tracked directory', () => {
    const parsed = parseCommit('cd ./pkg && git commit -m x')!
    expect(repoCandidates(parsed, 'C:/w', 'C:/session')).toEqual(['C:/w/pkg', 'C:/w', 'C:/session'])
  })

  test('falls back to the session directory, without duplicates', () => {
    const parsed = parseCommit('git commit -m x')!
    expect(repoCandidates(parsed, undefined, 'C:/session')).toEqual(['C:/session'])
    expect(repoCandidates(parsed, 'C:/session', 'C:/session')).toEqual(['C:/session'])
  })
})
