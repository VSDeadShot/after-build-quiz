// Integration check, run with Node (not `claude plugin test`, whose environment
// has no processes):  node tests/integration/git-cat-file.mjs
//
// Creates a throwaway repo in the OS temp folder and runs the real
// `cat-file -e <sha>^{commit}` through hooks/git.ts with a no-shell runner, to
// prove the `^{commit}` suffix reaches git intact. The key case: a blob's sha
// with `^{commit}` must FAIL; if the suffix were lost, git would only check
// that the object exists and exit 0. The engine's own spawn ($.process.run) is
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
} finally {
  rmSync(repo, { recursive: true, force: true })
}

console.log(failures === 0 ? 'git-cat-file integration: all passed' : `git-cat-file integration: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
