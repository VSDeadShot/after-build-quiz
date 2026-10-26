// Integration check, run with Node (not `claude plugin test`, whose environment
// has no processes):  node tests/integration/git-cat-file.mjs
//
// Creates a throwaway repo in the OS temp folder and runs the real
// `cat-file -e <sha>^{commit}` through hooks/git.ts with a no-shell runner, to
// prove the `^{commit}` suffix reaches git intact. The key case: a blob's sha
// with `^{commit}` must FAIL; if the suffix were lost, git would only check
// that the object exists and exit 0. It also checks what tests/fake-git.ts
// assumes about real git: one-call rev-parse output, -F --author exact match,
// the --since format, detached HEAD. A second throwaway repo, with settings that
// would change git's output (color, no prefixes, 1 line of context, quoted
// paths), builds a real context pack: line numbers, renames, deletions, binary,
// CRLF, quoted and spaced names, secret files, and the `git show` layout the fake
// reproduces. The engine's own spawn ($.process.run) is covered by the
// scratch-repo run.
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildContextPack, SHOW_COMMIT } from '../../hooks/context.ts'
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

const packRepo = mkdtempSync(join(tmpdir(), 'abq-pack-'))
try {
  const put = (path, content) => {
    mkdirSync(join(packRepo, path, '..'), { recursive: true })
    writeFileSync(join(packRepo, path), content)
  }
  const lines = (count, word = 'line') => Array.from({ length: count }, (_, i) => `${word} ${i + 1}\n`).join('')
  setupGit(packRepo, 'init', '-q')
  for (const [key, value] of [
    ['user.name', 'Integration Test'], ['user.email', 'integration@example.invalid'], ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'], ['color.ui', 'always'], ['color.diff', 'always'], ['diff.noprefix', 'true'],
    ['diff.mnemonicPrefix', 'true'], ['diff.context', '1'], ['diff.renames', 'false'], ['core.quotePath', 'true'],
  ]) setupGit(packRepo, 'config', key, value)

  put('src/a.ts', lines(40))
  put('src/old.ts', lines(12, 'old'))
  put('my file.ts', 'x\n')
  put('café.ts', 'a\n')
  put('crlf.ts', 'one\r\ntwo\r\n')
  put('logo.bin', Buffer.from([0, 1, 2, 3, 0, 255]))
  put('.env.production', 'API_TOKEN=tok_live_do_not_leak\n')
  put('certs/server.pem', `-----BEGIN ${'PRIVATE'} KEY-----\nabc\n`) // split so secret scanners do not flag the fixture
  put('README.md', '# readme\n')
  setupGit(packRepo, 'add', '-A')
  setupGit(packRepo, 'commit', '-q', '-m', 'root')
  const root = setupGit(packRepo, 'rev-parse', 'HEAD')

  put('src/a.ts', lines(40).replace('line 20\n', 'changed 20\n'))
  setupGit(packRepo, 'mv', 'src/old.ts', 'src/new.ts')
  put('src/new.ts', lines(12, 'old').replace('old 6\n', 'new 6\n'))
  put('my file.ts', 'y\n')
  put('café.ts', 'b\n')
  put('crlf.ts', 'one\r\nTWO\r\n')
  put('logo.bin', Buffer.from([0, 9, 9, 9, 0, 255]))
  setupGit(packRepo, 'mv', '.env.production', 'settings.txt')
  put('settings.txt', 'API_TOKEN=tok_live_do_not_leak\nDEBUG=1\n')
  setupGit(packRepo, 'rm', '-q', 'certs/server.pem')
  put('SPEC.md', '# spec\n')
  setupGit(packRepo, 'add', '-A')
  setupGit(packRepo, 'commit', '-q', '-m', 'Change line 20', '-m', 'Why: the API drops the first call.')
  const head = setupGit(packRepo, 'rev-parse', 'HEAD')

  const raw = await git(run, packRepo, ['show', ...SHOW_COMMIT, head])
  const nul = raw.stdout.indexOf('\x00')
  check('show prints the message, NUL, two newlines, then the diff (the fake\'s layout)',
    nul > 0 && raw.stdout.slice(nul + 1).startsWith('\n\ndiff --git '))

  const built = await buildContextPack(run, { repo: packRepo, repoName: 'pack', hash: head })
  check(`context pack is built (${built.isBuilt ? 'ok' : built.reason})`, built.isBuilt)
  if (built.isBuilt) {
    const { text, diffRefs, codeRefs, omitted } = built.pack
    check('message body is in the pack', text.includes('Why: the API drops the first call.'))
    check('-U5 holds against diff.context=1 (a.ts:15..25 citable, :14 not)',
      diffRefs.has('src/a.ts:15') && diffRefs.has('src/a.ts:20') && diffRefs.has('src/a.ts:25') && !diffRefs.has('src/a.ts:14'))
    check('prefixes hold against diff.noprefix / mnemonicPrefix', text.includes('=== src/a.ts (modified, +1 -1)'))
    check('no color codes against color.ui=always', !text.includes('\x1b'))
    check('a quoted non-ASCII name and a name with a space are read', diffRefs.has('café.ts:1') && diffRefs.has('my file.ts:1'))
    check('CRLF lines are numbered and the CR dropped', diffRefs.has('crlf.ts:2') && !text.includes('\r'))
    check('rename found against diff.renames=false', text.includes('=== src/new.ts (renamed from src/old.ts') && diffRefs.has('src/new.ts:6'))
    check('binary file omitted', omitted.includes('logo.bin: binary, omitted'))
    check('renamed .env and deleted .pem omitted, their contents absent',
      omitted.includes('settings.txt: secret file, omitted') && omitted.includes('certs/server.pem: secret file, omitted') &&
      !text.includes('tok_live') && !text.includes('PRIVATE KEY'))
    check('surrounding code from the blob at the commit (a.ts:1 and :40)', codeRefs.has('src/a.ts:1') && codeRefs.has('src/a.ts:40'))
    check('recent subjects come from log <sha>', text.includes('## Recent commits (newest first)\n- root\n'))
    check('docs at the commit: README and SPEC, no AGENTS',
      text.includes('### README.md\n# readme') && text.includes('### SPEC.md\n# spec') && !text.includes('### AGENTS.md'))
  }

  const rootPack = await buildContextPack(run, { repo: packRepo, repoName: 'pack', hash: root })
  check('a root commit has no recent subjects', rootPack.isBuilt && rootPack.pack.text.includes('## Recent commits (newest first)\n(none)'))

  const tree = await git(run, packRepo, ['cat-file', 'blob', `${head}:src`])
  check(`cat-file blob refuses a tree (exit ${tree.exitCode})`, tree.exitCode !== 0)
} finally {
  rmSync(packRepo, { recursive: true, force: true })
}

console.log(failures === 0 ? 'git-cat-file integration: all passed' : `git-cat-file integration: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
