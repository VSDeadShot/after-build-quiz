// Integration check, run with Node (not `claude plugin test`, whose environment
// has no processes):  node tests/integration/git-cat-file.mjs
//
// Creates a throwaway repo in the OS temp folder and runs the real
// `cat-file -e <sha>^{commit}` through hooks/git.ts with a no-shell runner, to
// prove the `^{commit}` suffix reaches git intact. The key case: a blob's sha
// with `^{commit}` must FAIL; if the suffix were lost, git would only check
// that the object exists and exit 0. It also checks what tests/fake-git.ts
// assumes about real git: one-call rev-parse output, -F --author exact match,
// the --since format, detached HEAD. The engine's own spawn ($.process.run) is
// covered by the scratch-repo run.
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { git } from '../../hooks/git.ts'

const run = (argv, init) =>
  new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { shell: false, windowsHide: true, cwd: init?.cwd }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error)
      resolve({ exitCode: error ? error.code : 0, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
    })
  })

// Setup uses git directly: it is the test harness building a fixture, not the plugin.
const setupGit = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

const repo = mkdtempSync(join(tmpdir(), 'abq-int-'))
let failures = 0
const check = (name, isOk) => {
  console.log(`${isOk ? 'pass' : 'FAIL'}  ${name}`)
  if (!isOk) failures++
}

try {
  setupGit(repo, 'init', '-q')
  setupGit(repo, 'config', 'user.name', 'Integration Test')
  setupGit(repo, 'config', 'user.email', 'integration@example.invalid')
  setupGit(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  setupGit(repo, 'add', 'a.txt')
  setupGit(repo, 'commit', '-q', '-m', 'fixture')
  const commit = setupGit(repo, 'rev-parse', 'HEAD')
  const blob = setupGit(repo, 'rev-parse', 'HEAD:a.txt')

  const ofCommit = await git(run, repo, ['cat-file', '-e', `${commit}^{commit}`])
  check(`commit sha with ^{commit} exists (exit ${ofCommit.exitCode})`, ofCommit.exitCode === 0)

  const ofBlob = await git(run, repo, ['cat-file', '-e', `${blob}^{commit}`])
  check(`blob sha with ^{commit} is refused by git (exit ${ofBlob.exitCode})`, ofBlob.exitCode !== 0)

  const blobPlain = await git(run, repo, ['cat-file', '-e', blob])
  check(`blob sha without the suffix exists (control, exit ${blobPlain.exitCode})`, blobPlain.exitCode === 0)

  const absent = await git(run, repo, ['cat-file', '-e', `${'0'.repeat(40)}^{commit}`])
  check(`unknown sha with ^{commit} is refused (exit ${absent.exitCode})`, absent.exitCode !== 0)

  // What tests/fake-git.ts assumes about real git, checked here.
  const headLine = await git(run, repo, ['rev-parse', '--show-toplevel', 'HEAD', '--abbrev-ref', 'HEAD'])
  const [top, sha, branch] = headLine.stdout.split(/\r?\n/).filter(Boolean)
  check(`one rev-parse gives root, HEAD and branch (${branch})`, headLine.exitCode === 0 && top !== undefined && sha === commit && branch !== 'HEAD')

  const commitAs = (email, file, date) => {
    writeFileSync(join(repo, file), `${file}\n`)
    setupGit(repo, 'add', file)
    execFileSync('git', ['-C', repo, '-c', `user.email=${email}`, 'commit', '-q', '-m', file], {
      env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
    })
  }
  commitAs('a.b@example.com', 'mine.txt', '2026-10-10T08:30:05Z')
  commitAs('xa.b@example.com', 'prefix.txt', '2026-10-10T08:30:06Z')
  commitAs('aXb@example.com', 'dot.txt', '2026-10-10T08:30:07Z')
  commitAs('a.b@example.com.evil', 'suffix.txt', '2026-10-10T08:30:08Z')
  const authored = await git(run, repo, ['log', '--format=%s', '-F', '--author=<a.b@example.com>', `${commit}..HEAD`])
  check(`-F --author=<a.b@example.com> matches only that author (${authored.stdout.trim().split(/\r?\n/).join(', ')})`,
    authored.stdout.trim() === 'mine.txt')

  const since = await git(run, repo, ['log', '--format=%s', '--since=2026-10-10T08:30:07Z', 'HEAD'])
  check(`--since=<ISO, Z> keeps commits at or after it (${since.stdout.trim().split(/\r?\n/).join(', ')})`,
    since.stdout.trim().split(/\r?\n/).join(',') === 'suffix.txt,dot.txt')

  setupGit(repo, 'checkout', '-q', '--detach')
  const detached = await git(run, repo, ['rev-parse', '--show-toplevel', 'HEAD', '--abbrev-ref', 'HEAD'])
  check('detached HEAD reports the branch as "HEAD"', detached.stdout.split(/\r?\n/).filter(Boolean)[2] === 'HEAD')
} finally {
  rmSync(repo, { recursive: true, force: true })
}

console.log(failures === 0 ? 'git-cat-file integration: all passed' : `git-cat-file integration: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
