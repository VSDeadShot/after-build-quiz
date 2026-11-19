import { describe, expect, test } from 'claude-code/testing'

import { buildContextPack, isSecretLine, REDACTED } from '../hooks/context.ts'
import type { ContextPack } from '../hooks/context.ts'
import type { Run } from '../hooks/git.ts'
import { commit, fakeGit, makeRepo } from './fake-git.ts'
import type { FakeCommit, FakeRepo } from './fake-git.ts'

const TOP = 'C:/work/foo'

// One hunk of `git show` output; lines are prefixed ' ', '+' or '-' as git prints them.
const hunk = (oldStart: number, newStart: number, lines: string[], label = '') => {
  const oldCount = lines.filter(line => !line.startsWith('+')).length
  const newCount = lines.filter(line => !line.startsWith('-')).length
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${label}\n${lines.join('\n')}\n`
}
const modified = (path: string, ...hunks: string[]) =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${hunks.join('')}`
const added = (path: string, lines: string[]) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/${path}\n` +
  hunk(0, 1, lines.map(line => `+${line}`))
const deleted = (path: string, lines: string[]) =>
  `diff --git a/${path} b/${path}\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/${path}\n+++ /dev/null\n` +
  hunk(1, 0, lines.map(line => `-${line}`))
const renamed = (from: string, to: string, ...hunks: string[]) =>
  `diff --git a/${from} b/${to}\nsimilarity index ${hunks.length === 0 ? 100 : 90}%\nrename from ${from}\nrename to ${to}\n` +
  (hunks.length === 0 ? '' : `index 1111111..2222222 100644\n--- a/${from}\n+++ b/${to}\n${hunks.join('')}`)
const binary = (path: string) =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\nBinary files a/${path} and b/${path} differ\n`
const submodule = (path: string) =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 160000\n--- a/${path}\n+++ b/${path}\n` +
  '@@ -1 +1 @@\n-Subproject commit 1111111111111111111111111111111111111111\n+Subproject commit 2222222222222222222222222222222222222222\n'

const numbered = (count: number, word = 'line') => Array.from({ length: count }, (_, i) => `${word} ${i + 1}`)
const fileOf = (lines: string[]) => `${lines.join('\n')}\n`

const setup = (options: Parameters<typeof commit>[1] = {}) => {
  const repo = makeRepo(TOP)
  const made = commit(repo, options)
  return { repo, made }
}

const build = async (repo: FakeRepo, made: FakeCommit, run?: Run) => {
  const git = fakeGit(repo)
  const result = await buildContextPack(run ?? git.run, { repo: TOP, repoName: 'foo', hash: made.hash })
  if (!result.isBuilt) throw new Error(`not built: ${result.reason}`)
  return { pack: result.pack, calls: git.calls }
}

const refs = (path: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${path}:${from + i}`)
const sorted = (set: ReadonlySet<string>) => [...set].sort()
const section = (pack: ContextPack, name: string) => {
  const start = pack.text.indexOf(`## ${name}`)
  if (start === -1) return ''
  const next = pack.text.indexOf('\n## ', start + 3)
  return pack.text.slice(start, next === -1 ? undefined : next)
}

describe('buildContextPack: the diff', () => {
  test('numbers hunk lines by the new side; added and context lines are citable, removed lines are not', async () => {
    const { repo, made } = setup({
      patch: modified('src/a.ts', hunk(10, 10, [' ten', ' eleven', '-old twelve', '+new twelve', '+new thirteen', ' fourteen'], ' function f()')),
    })
    const { pack } = await build(repo, made)
    expect(sorted(pack.diffRefs)).toEqual(refs('src/a.ts', 10, 14).sort())
    const diff = section(pack, 'Diff')
    expect(diff).toContain('=== src/a.ts (modified, +2 -1)')
    expect(diff).toContain('@@ -10,4 +10,5 @@ function f()')
    expect(diff).toContain('   10   ten\n   11   eleven\n      - old twelve\n   12 + new twelve\n   13 + new thirteen\n   14   fourteen')
  })

  test('an added file is citable at its lines', async () => {
    const { repo, made } = setup({ patch: added('src/new.ts', ['one', 'two', 'three']) })
    const { pack } = await build(repo, made)
    expect(sorted(pack.diffRefs)).toEqual(refs('src/new.ts', 1, 3))
    expect(section(pack, 'Diff')).toContain('=== src/new.ts (added, +3 -0)')
  })

  test('a deleted file is citable at its old lines, and says so', async () => {
    const { repo, made } = setup({ patch: deleted('src/old.ts', ['alpha', 'beta']) })
    const { pack } = await build(repo, made)
    expect(sorted(pack.diffRefs)).toEqual(refs('src/old.ts', 1, 2))
    const diff = section(pack, 'Diff')
    expect(diff).toContain('=== src/old.ts (deleted; line numbers from the parent, +0 -2)')
    expect(diff).toContain('    1 - alpha\n    2 - beta')
  })

  test('a renamed file is listed under its new path; a pure rename has no lines', async () => {
    const { repo, made } = setup({
      patch: renamed('src/before.ts', 'src/after.ts', hunk(3, 3, [' keep', '-was', '+now'])) + renamed('lib/x.ts', 'lib/y.ts'),
    })
    const { pack } = await build(repo, made)
    expect(sorted(pack.diffRefs)).toEqual(['src/after.ts:3', 'src/after.ts:4'])
    const diff = section(pack, 'Diff')
    expect(diff).toContain('=== src/after.ts (renamed from src/before.ts, +1 -1)')
    expect(diff).toContain('=== lib/y.ts (renamed from lib/x.ts, +0 -0)')
  })

  test('binary files, submodules and lockfiles are listed as omitted, with no lines', async () => {
    const { repo, made } = setup({
      patch: binary('assets/logo.png') + submodule('vendor/lib') + added('package-lock.json', numbered(50)) +
        added('src/a.ts', ['code']),
    })
    const { pack } = await build(repo, made)
    expect(sorted(pack.diffRefs)).toEqual(['src/a.ts:1'])
    expect(pack.omitted).toContain('assets/logo.png: binary, omitted')
    expect(pack.omitted).toContain('vendor/lib: submodule, omitted')
    expect(pack.omitted).toContain('package-lock.json: lockfile, omitted')
    expect(section(pack, 'Diff')).not.toContain('package-lock.json')
    expect(section(pack, 'Omitted')).toContain('- assets/logo.png: binary, omitted')
  })

  test('quoted paths are unquoted, octal UTF-8 and escapes included; a path with a space keeps it', async () => {
    const quoted = 'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\nindex 1111111..2222222 100644\n' +
      '--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n' + hunk(1, 1, ['-a', '+b'])
    const tab = 'diff --git "a/tab\\there.ts" "b/tab\\there.ts"\nnew file mode 100644\nindex 0000000..2222222\n' +
      '--- /dev/null\n+++ "b/tab\\there.ts"\n' + hunk(0, 1, ['+x'])
    // git ends ---/+++ lines with a tab when the name has a space
    const spaced = 'diff --git a/my file.ts b/my file.ts\nindex 1111111..2222222 100644\n' +
      '--- a/my file.ts\t\n+++ b/my file.ts\t\n' + hunk(7, 7, ['-c', '+d'])
    const { repo, made } = setup({ patch: quoted + tab + spaced })
    const { pack } = await build(repo, made)
    expect(sorted(pack.diffRefs)).toEqual(['café.ts:1', 'my file.ts:7', 'tab\there.ts:1'])
  })

  test('code files come first, largest change first, ties by path; docs files after', async () => {
    const { repo, made } = setup({
      patch: added('README.md', numbered(40)) + added('src/small.ts', numbered(2)) + added('src/big.ts', numbered(9)) +
        added('src/also.ts', numbered(2)) + added('docs/guide.txt', numbered(3)),
    })
    const { pack } = await build(repo, made)
    const order = [...section(pack, 'Diff').matchAll(/^=== (\S+)/gm)].map(match => match[1])
    expect(order).toEqual(['src/big.ts', 'src/also.ts', 'src/small.ts', 'README.md', 'docs/guide.txt'])
  })

  test('the diff stops adding hunks at the size limit and says what it cut; a later small file still fits', async () => {
    const wide = (n: number) => `+${String(n).padStart(3, '0')} ${'x'.repeat(380)}`
    const hunks = Array.from({ length: 30 }, (_, h) =>
      hunk(h * 20 + 1, h * 20 + 1, Array.from({ length: 10 }, (_, i) => wide(h * 10 + i))))
    const { repo, made } = setup({ patch: modified('src/huge.ts', ...hunks) + added('src/tiny.ts', ['small']) })
    const { pack } = await build(repo, made)
    expect(section(pack, 'Diff').length).toBeLessThan(42_000)
    const kept = [...pack.diffRefs].filter(ref => ref.startsWith('src/huge.ts:')).length
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(300)
    const cut = 30 - kept / 10
    expect(pack.omitted).toContain(`src/huge.ts: ${cut} hunks omitted (size limit)`)
    expect(section(pack, 'Diff')).toContain(`(${cut} more hunks omitted)`)
    expect(pack.diffRefs.has('src/tiny.ts:1')).toBe(true)
  })

  test('long lines are cut at 400 characters and a carriage return is dropped', async () => {
    const { repo, made } = setup({ patch: modified('src/a.ts', hunk(1, 1, [`+${'y'.repeat(500)}`, '+windows\r'])) })
    const { pack } = await build(repo, made)
    const diff = section(pack, 'Diff')
    expect(diff).toContain(`    1 + ${'y'.repeat(400)}…\n`)
    expect(diff).toContain('    2 + windows\n')
    expect(diff).not.toContain('\r')
  })
})

describe('buildContextPack: secret files', () => {
  const SECRET = 'API_TOKEN=tok_live_do_not_leak'
  const KEY = `-----BEGIN ${'PRIVATE'} KEY-----` // split so secret scanners do not flag the fixture

  test('.env*, *.pem and *.key files are left out under their old or new path', async () => {
    const { repo, made } = setup({
      patch:
        modified('.env', hunk(1, 1, [`-${SECRET}`, `+${SECRET}2`])) +
        added('config/.env.local', [SECRET]) +
        renamed('.env.production', 'config/settings.txt', hunk(1, 1, [` ${SECRET}`, '+DEBUG=1'])) +
        deleted('certs/server.pem', [KEY, 'abc']) +
        added('keys/signing.KEY', [KEY]) +
        added('src/a.ts', ['code']),
      blobs: { 'config/settings.txt': `${SECRET}\nDEBUG=1\n`, 'src/a.ts': 'code\n' },
    })
    const { pack } = await build(repo, made)
    expect(pack.text).not.toContain('tok_live')
    expect(pack.text).not.toContain('PRIVATE KEY')
    expect(sorted(pack.diffRefs)).toEqual(['src/a.ts:1'])
    expect(sorted(pack.codeRefs)).toEqual(['src/a.ts:1'])
    for (const path of ['.env', 'config/.env.local', 'config/settings.txt', 'certs/server.pem', 'keys/signing.KEY']) {
      expect(pack.omitted).toContain(`${path}: secret file, omitted`)
    }
  })

  test('look-alike names are kept', async () => {
    const { repo, made } = setup({
      patch: added('src/environment.ts', ['a']) + added('src/keys.ts', ['b']) + added('src/api.key.ts', ['c']) +
        added('docs/pem-format.md', ['d']),
    })
    const { pack } = await build(repo, made)
    expect(sorted(pack.diffRefs)).toEqual(['docs/pem-format.md:1', 'src/api.key.ts:1', 'src/environment.ts:1', 'src/keys.ts:1'])
    expect(pack.omitted.filter(line => line.includes('secret'))).toEqual([])
  })
})

describe('buildContextPack: surrounding code', () => {
  test('±30 lines around each hunk from the blob at that commit, clamped, without repeating diff lines', async () => {
    const after = numbered(100)
    after[49] = 'changed 50'
    const { repo, made } = setup({
      patch: modified('src/a.ts', hunk(45, 45, [...numbered(49).slice(44).map(l => ` ${l}`), '-line 50', '+changed 50',
        ...numbered(55).slice(50).map(l => ` ${l}`)])),
      blobs: { 'src/a.ts': fileOf(after) },
    })
    const { pack } = await build(repo, made)
    expect(sorted(pack.diffRefs)).toEqual(refs('src/a.ts', 45, 55).sort())
    expect(sorted(pack.codeRefs)).toEqual(refs('src/a.ts', 15, 85).sort())
    const around = section(pack, 'Surrounding code at this commit')
    expect(around).toContain('=== src/a.ts\n   15 | line 15\n')
    expect(around).toContain('   44 | line 44\n      …\n   56 | line 56\n')
    expect(around).toContain('   85 | line 85\n')
    expect(around).not.toContain('| line 14\n')
    expect(around).not.toContain('| changed 50')
  })

  test('windows near the top are clamped and overlapping windows merge', async () => {
    const lines = numbered(120)
    const { repo, made } = setup({
      patch: modified('src/a.ts', hunk(2, 2, [' line 2', '-x', '+line 3']), hunk(40, 40, [' line 40', '-y', '+line 41'])),
      blobs: { 'src/a.ts': fileOf(lines) },
    })
    const { pack } = await build(repo, made)
    expect(sorted(pack.codeRefs)).toEqual(refs('src/a.ts', 1, 71).sort())
  })

  test('only the 5 most-changed code files get surrounding code; deleted and missing blobs are skipped', async () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => ({ path: `src/${name}.ts`, count: 10 - i }))
    const blobs: Record<string, string> = {}
    for (const file of files) blobs[file.path] = fileOf(numbered(file.count))
    delete blobs['src/b.ts']
    const { repo, made } = setup({
      patch: files.map(file => added(file.path, numbered(file.count))).join('') + deleted('src/gone.ts', numbered(30)),
      blobs,
    })
    const { pack, calls } = await build(repo, made)
    const fetched = calls.filter(call => call.includes('blob')).map(call => call.at(-1))
    expect(fetched).toEqual(['a', 'b', 'c', 'd', 'e'].map(name => `${made.hash}:src/${name}.ts`)
      .concat(['SPEC.md', 'AGENTS.md', 'README.md'].map(doc => `${made.hash}:${doc}`)))
    expect(pack.omitted).toContain('src/b.ts: surrounding code unavailable')
  })

  test('surrounding code stops at its size limit and says so', async () => {
    const wide = (n: number) => `${n} ${'z'.repeat(300)}`
    const files = ['a', 'b', 'c', 'd', 'e'].map(name => `src/${name}.ts`)
    const blobs: Record<string, string> = {}
    for (const path of files) blobs[path] = fileOf(Array.from({ length: 200 }, (_, i) => wide(i + 1)))
    const { repo, made } = setup({
      patch: files.map(path => modified(path, hunk(100, 100, ['-old', `+${wide(100)}`]))).join(''),
      blobs,
    })
    const { pack } = await build(repo, made)
    expect(section(pack, 'Surrounding code at this commit').length).toBeLessThan(22_000)
    expect(pack.omitted).toContain('surrounding code: cut at the size limit')
  })
})

describe('buildContextPack: message, history, docs', () => {
  test('the commit message, subject and body, is in the pack; a long one is cut at about 2k', async () => {
    const short = setup({ subject: 'Add retry to fetch', body: 'Retries twice because the API drops the first call.' })
    const { pack } = await build(short.repo, short.made)
    expect(section(pack, 'Commit message')).toContain('Add retry to fetch\n\nRetries twice because the API drops the first call.')

    const long = setup({ subject: 'Big', body: 'w'.repeat(5000), patch: added('src/a.ts', ['x']) })
    const { pack: cut } = await build(long.repo, long.made)
    expect(section(cut, 'Commit message').length).toBeLessThan(2_200)
    expect(cut.omitted.some(line => /^commit message: \d+ characters omitted$/.test(line))).toBe(true)
  })

  test('recent commits: the 10 before this one, newest first, each cut at 200; none for a root commit', async () => {
    const repo = makeRepo(TOP)
    const root = commit(repo, { subject: 'root commit', committedAt: '2026-10-01T00:00:00Z' })
    for (let day = 2; day <= 12; day++) {
      commit(repo, { subject: day === 7 ? `long ${'s'.repeat(300)}` : `day ${day}`, committedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z` })
    }
    const latest = commit(repo, { subject: 'the commit itself', committedAt: '2026-10-13T00:00:00Z' })

    const { pack } = await build(repo, latest)
    const recent = section(pack, 'Recent commits (newest first)')
    const listed = [...recent.matchAll(/^- (.*)$/gm)].map(match => match[1]!)
    expect(listed.length).toBe(10)
    expect(listed[0]).toBe('day 12')
    expect(listed.at(-1)).toBe('day 3')
    expect(listed.find(subject => subject.startsWith('long '))!.length).toBe(201)
    expect(recent).not.toContain('the commit itself')

    const { pack: first } = await build(repo, root)
    expect(section(first, 'Recent commits (newest first)')).toContain('(none)')
  })

  test('repo docs at that commit, each cut at 8k; missing ones are left out', async () => {
    const { repo, made } = setup({ blobs: { 'SPEC.md': '# Spec\nrules here\n', 'README.md': 'r'.repeat(9000) } })
    const { pack } = await build(repo, made)
    const docs = section(pack, 'Repo docs at this commit')
    expect(docs).toContain('### SPEC.md\n# Spec\nrules here')
    expect(docs).not.toContain('### AGENTS.md')
    expect(docs).toContain('### README.md')
    expect(docs.length).toBeLessThan(8_000 + 200 + 100)
    expect(pack.omitted.some(line => /^README\.md: \d+ characters omitted$/.test(line))).toBe(true)
  })
})

describe('buildContextPack: safety', () => {
  test('the same commit gives a byte-identical pack', async () => {
    const { repo, made } = setup({
      body: 'why',
      patch: modified('src/a.ts', hunk(1, 1, ['-a', '+b'])) + binary('x.png'),
      blobs: { 'src/a.ts': 'b\n', 'SPEC.md': 'spec\n' },
    })
    const one = await build(repo, made)
    const two = await build(repo, made)
    expect(two.pack.text).toBe(one.pack.text)
    expect(sorted(two.pack.codeRefs)).toEqual(sorted(one.pack.codeRefs))
    expect(two.pack.omitted).toEqual(one.pack.omitted)
  })

  test('a commit git cannot show is not built; a run that throws is not built; nothing throws', async () => {
    const repo = makeRepo(TOP)
    commit(repo)
    const git = fakeGit(repo)
    const missing = await buildContextPack(git.run, { repo: TOP, repoName: 'foo', hash: 'f'.repeat(40) })
    expect(missing.isBuilt).toBe(false)

    const broken: Run = async () => { throw new Error('spawn failed') }
    const thrown = await buildContextPack(broken, { repo: TOP, repoName: 'foo', hash: 'f'.repeat(40) })
    expect(thrown).toEqual({ isBuilt: false, reason: 'Error: spawn failed' })
  })

  test('a show output the process limit cut short is still used, and says so', async () => {
    const { repo, made } = setup({ patch: added('src/a.ts', ['x']) })
    const git = fakeGit(repo)
    const cutShort: Run = async (argv, init) => {
      const result = await git.run(argv, init)
      return argv.includes('show') ? { ...result, isStdoutTruncated: true } : result
    }
    const { pack } = await build(repo, made, cutShort)
    expect(pack.diffRefs.has('src/a.ts:1')).toBe(true)
    expect(pack.omitted).toContain('diff: the end was cut by the process output limit')
  })

  test('runs only show, log and cat-file blob through git.ts, in a fixed order', async () => {
    const { repo, made } = setup({ patch: added('src/a.ts', ['x']), blobs: { 'src/a.ts': 'x\n' } })
    const { calls } = await build(repo, made)
    const sha = made.hash
    expect(calls).toEqual([
      ['git', '-C', TOP, '--no-pager', 'show', '--no-ext-diff', '--no-textconv', '--format=%B%x00', '--no-color',
        '--no-show-signature', '--find-renames', '-U5', '--src-prefix=a/', '--dst-prefix=b/', sha],
      ['git', '-C', TOP, '--no-pager', 'log', '--no-ext-diff', '--no-textconv', '--no-merges', '-n', '11',
        '--format=%H%x1f%P%x1f%aI%x1f%cI%x1f%s', sha],
      ['git', '-C', TOP, '--no-pager', 'cat-file', 'blob', `${sha}:src/a.ts`],
      ['git', '-C', TOP, '--no-pager', 'cat-file', 'blob', `${sha}:SPEC.md`],
      ['git', '-C', TOP, '--no-pager', 'cat-file', 'blob', `${sha}:AGENTS.md`],
      ['git', '-C', TOP, '--no-pager', 'cat-file', 'blob', `${sha}:README.md`],
    ])
  })
})

// Fixture secrets are assembled at runtime so secret scanners (the pre-push scan, push protection) do not
// flag this file. None of them is a real credential.
const S = {
  google: 'AIza' + 'B'.repeat(35),
  openai: 'sk-' + 'proj-' + 'a1'.repeat(12),
  anthropic: 'sk-' + 'ant-api03-' + 'b2'.repeat(12),
  github: 'ghp' + '_' + 'c3'.repeat(18),
  githubOauth: 'gho' + '_' + 'd4'.repeat(18),
  githubPat: 'github' + '_pat_' + '11AB'.repeat(6),
  aws: 'AKIA' + 'Z7'.repeat(8),
  slack: 'xox' + 'b-' + '1234567890-abcdefghij',
  stripe: 'sk' + '_live_' + 'e5'.repeat(12),
  stripeRestricted: 'rk' + '_live_' + 'f6'.repeat(12),
  jwt: 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' + '.' + 'eyJ' + 'yb2xlIjoic2VydmljZV9yb2xlIn0' + '.' + 'g7'.repeat(16),
  supabase: 'sb' + '_secret_' + 'h8'.repeat(16),
  bcrypt: '$2b' + '$12$' + 'i'.repeat(53),
  token: 'tok' + '_live_' + 'do_not_leak',
  bearer: 'q7Lm' + 'R2xV'.repeat(5),
}
const BEGIN = `-----BEGIN ${'PRIVATE'} KEY-----`
const END = `-----END ${'PRIVATE'} KEY-----`
const BODY = ['MIIEvQ' + 'A'.repeat(58), 'B'.repeat(64), 'C'.repeat(20) + '=']

// Prefixes that end in a non-secret `name:` / `name=` or a flag: an earlier match must never hide a later secret.
const PREFIXES = ['Error: ', 'note: ', 'env: ', 'x=1 ', '--verbose ']

// Rule 4b: a quoted value of 8+ characters set to a secret-looking name, anywhere in a line.
const QUOTED_POSITIVES: [string, string][] = [
  ['4b camelCase key', 'apiKey: "q9w8e7r6t5"'],
  ['4b password', `const password = 'correct-horse-battery'`],
  ['4b quoted JSON name', '"token": "abc123def456"'],
  ['4b snake_case keyword argument', 'connect(api_key="abcd1234efgh")'],
  ['4b client secret', `  client_secret: 'abcdefghij',`],
  ['4b upper-case constant', `const X_API_KEY = 'abcdefgh12'`],
  ['4b Go short assignment', 'token := "abcdefghijkl"'],
  ['4b apikey =', 'apikey = "abcd1234efgh"'],
  ['4b apikey:', "apikey: 'abcd1234efgh'"],
  ['4b quoted JSON compound name', '"apikey": "abcd1234efgh"'],
  ['4b prefixed snake_case', 'openai_apikey="abcd1234efgh"'],
  ['4b header-style name', "'x-apikey': 'abcd1234efgh'"],
  ['4b camelCase prefix', "const myApikey = 'abcd1234efgh'"],
  ['4b clientsecret', "  clientsecret: 'abcdefghij',"],
  ['4b Go short assignment, compound', 'accesstoken := "abcdefghijkl"'],
  // a non-secret quoted value that holds a quoted secret assignment (the 3c4 audit)
  ['4b inside a non-secret quoted value', `cmd: "password='hunter2hunter2'"`],
]

// Rule 10: a Bearer token of 16+ characters, with or without an Authorization name.
const BEARER_POSITIVES: [string, string][] = [
  ['10 bare header', `Authorization: Bearer ${S.bearer}`],
  ['10 JSON header', `"Authorization": "Bearer ${S.bearer}"`],
  ['10 curl -H', `curl -H "Authorization: Bearer ${S.bearer}" https://api.example.com/v1/me`],
  ['10 lower-case, template literal', `fetch(url, { headers: { authorization: \`bearer ${S.bearer}\` } })`],
  ['10 no Authorization name', `const header = 'Bearer ${S.bearer}'`],
  ['10 a placeholder, then a real token', `# Bearer <your-access-token>, e.g. Bearer ${S.bearer}`],
  // a placeholder token run that would take a later Bearer with it (the 3c4 audit)
  ['10 a placeholder run holding a later Bearer', `Bearer <your-access-token>|Bearer ${S.bearer}`],
]

describe('isSecretLine: patterns', () => {
  test('each pattern matches a line holding its kind of secret', () => {
    const positives: [string, string][] = [
      ['1 Google API key', `loadMaps('${S.google}')`],
      ['2 OpenAI key', `call('${S.openai}')`],
      ['2 Anthropic key', `call("${S.anthropic}")`],
      ['3 PEM header', `-----BEGIN RSA ${'PRIVATE'} KEY-----`],
      ['3 OpenSSH header', `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----`],
      ['4a env line', `API_TOKEN=${S.token}`],
      ['4a exported', 'export DB_PASSWORD=hunter2hunter2'],
      ['4a name with a trailing part', 'SECRET_KEY_BASE=0123456789abcdef'],
      ['4a quoted, spaced', `  STRIPE_SECRET = 'whsec_abcdefgh'`],
      ['5 credential URL', 'db = connect("' + 'postgres://' + 'admin:s3cret' + '@db.example.com/app")'],
      ['6 bcrypt hash', `hash: '${S.bcrypt}'`],
      ['7 GitHub token', `auth(${JSON.stringify(S.github)})`],
      ['7 GitHub OAuth token', `auth('${S.githubOauth}')`],
      ['7 GitHub fine-grained token', `auth('${S.githubPat}')`],
      ['7 AWS key ID', `aws configure set id ${S.aws}`],
      ['7 Slack token', `slack('${S.slack}')`],
      ['7 Stripe secret key', `stripe('${S.stripe}')`],
      ['7 Stripe restricted key', `stripe('${S.stripeRestricted}')`],
      ['8 JWT (a Supabase service_role key)', `createClient(url, '${S.jwt}')`],
      ['9 Supabase secret key', `createClient(url, '${S.supabase}')`],
    ]
    for (const [name, line] of positives) expect([name, isSecretLine(line)]).toEqual([name, true])
  })

  test('ordinary code with secret-sounding names is not matched', () => {
    const negatives = [
      'token: string',
      'const key = getKey()',
      "{ key: 'id' }",
      'monkey = 1',
      'keyboard: true',
      'secretFiles = []',
      'MAX_TOKENS = 1024',
      'const tokenCount = 1024',
      "if (token === 'abcdefghij') return",
      'const { password } = form',
      'passwordHash: string',
      "const keyPrefix = 'abq:queue:'",
      "secretFiles: 'node_modules'",
      "const monkey = 'banana-bread'",
      'API_KEY=short',
      '// OpenAI keys start with sk-',
      'task-runner-for-the-background-jobs',
      'GitHub tokens start with ghp_ or github_pat_',
      `aws: ${'AKIA'}SHORT`,
      'Slack bot tokens look like xoxb-',
      'Stripe keys start with sk_live_',
      `publishable: '${'sb' + '_publishable_' + 'j9'.repeat(16)}'`,
      'header: eyJhbGciOi.eyJzdWIi.sig',
      'git clone https://user@example.com/repo.git',
      'BEGIN the key exchange',
    ]
    for (const line of negatives) expect([line, isSecretLine(line)]).toEqual([line, false])
  })

  test('accepted false positives are matched (redacting them is the safe side)', () => {
    const jwtSample = 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' + '.' + 'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0' +
      '.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const falsePositives: [string, string][] = [
      ['4a constant ending in a _PART', 'CACHE_KEY_PREFIX = "abq:queue:"'],
      ['4b a long key name', "{ key: 'session-start-status' }"],
      ['4b a fake-password fixture', "password: 'password123'"],
      ['3 a public key header', `-----BEGIN ${'PUBLIC'} KEY-----`],
      ['2 a 20+ character sk- CSS class', '.sk-loading-spinner-wrapper {'],
      ['5 a URL template built from variables', 'const url = `postgres://${user}:${pass}@${host}/db`'],
      ['8 the jwt.io sample token in a doc', `Example: ${jwtSample}`],
      ['8 a public Supabase anon key', `const anon = '${jwtSample}'`],
      ['9 an sb_secret_ placeholder in a doc', `SUPABASE_SECRET=${'sb' + '_secret_'}xxxxxxxxxxxxxxxxxxxx`],
      ['4a an unquoted constant on the right', 'apikey = DEFAULT_APIKEY_VALUE'],
      ['10 a doc example with a made-up token', 'Authorization: Bearer abcdefghijklmnop'],
    ]
    for (const [name, line] of falsePositives) expect([name, isSecretLine(line)]).toEqual([name, true])
  })

  test('quoted values set to secret names are matched (4b, incl. run-together compound names)', () => {
    for (const [name, line] of QUOTED_POSITIVES) expect([name, isSecretLine(line)]).toEqual([name, true])
  })

  test('run-together compound names are matched unquoted (4a)', () => {
    const positives: [string, string][] = [
      ['4a unquoted lower-case', 'apikey=abcd1234efgh'],
      ['4a exported, spaced', 'export secretkey = abcd1234efgh'],
      ['4a prefixed name', 'stripe_webhooksecret=whsec_abcdefgh'],
      ['4a trailing comment', 'refreshtoken=abcd1234efgh  # rotate monthly'],
    ]
    for (const [name, line] of positives) expect([name, isSecretLine(line)]).toEqual([name, true])
  })

  test('Bearer tokens are matched with or without an Authorization name (10)', () => {
    for (const [name, line] of BEARER_POSITIVES) expect([name, isSecretLine(line)]).toEqual([name, true])
  })

  test('every 4b and Bearer positive is still matched behind a non-secret prefix (no earlier match hides it)', () => {
    for (const [name, line] of [...QUOTED_POSITIVES, ...BEARER_POSITIVES]) {
      for (const prefix of PREFIXES) expect([name, prefix, isSecretLine(prefix + line)]).toEqual([name, prefix, true])
    }
  })

  test('the same Bearer line matches on every call (no regex state carried between calls)', () => {
    const line = `Authorization: Bearer ${S.bearer}`
    expect([isSecretLine(line), isSecretLine(line), isSecretLine(line)]).toEqual([true, true, true])
  })

  test('Bearer placeholders and compound look-alike names are not matched', () => {
    const negatives = [
      'Authorization: Bearer <your-access-token>',
      'Authorization: Bearer YOUR_TOKEN',
      'Authorization: Bearer YOUR_ACCESS_TOKEN_HERE',
      'curl -H "Authorization: Bearer ${API_ACCESS_TOKEN}"',
      'curl -H "Authorization: Bearer $GITHUB_ACCESS_TOKEN"',
      '"Authorization": "Bearer {{api_access_token}}"',
      'headers = {"Authorization": f"Bearer {settings.API_ACCESS_TOKEN}"}',
      'Authorization: Bearer xxxxxxxxxxxxxxxxxxxx',
      'Authorization: Bearer XXXX-XXXX-XXXX-XXXX',
      'Authorization: Bearer ...',
      'Authorization: Bearer …',
      "const header = 'Bearer ' + token",
      'const header = `Bearer ${token}`',
      'Bearer authentication is used by the API',
      'Authorization: Bearer short-token',
      'const bearer_token = getToken()',
      "apikeyPrefix = 'abq:queue:'",
      'apikeys: string[]',
      'apikey: ApiKeyConfig',
      'apikey = "short"',
      'apikey = process.env.APIKEY',
      'apikey = getKey()',
      'apikey == expectedApikeyValue',
      "const turkey = 'roast-dinner'",
      "hockey: 'stick-and-puck'",
    ]
    for (const line of negatives) expect([line, isSecretLine(line)]).toEqual([line, false])
  })
})

// 3c4: an unquoted value set to a secret name in the middle of a line. Values are built at runtime so
// secret scanners do not flag this file; none is a real credential.
describe('isSecretLine: mid-line assignments (4c)', () => {
  const LIVE = 'tok' + '_live_' + 'abc123'
  const POSITIVES: [string, string][] = [
    ['upper-case name in a sentence', `set API_TOKEN=${LIVE} before deploy`],
    ['the log KNOWN GAP sentence', `You pasted API_TOKEN=${S.token} here.`],
    ['ends a sentence', 'Run it with DB_PASSWORD=hunter2hunter2.'],
    ['URL query parameter', 'curl https://api.example.com/v1/items?limit=5&access_token=abc123def456ghi'],
    ['URL query in a request line', 'GET /cb?code=x&token=a1b2c3d4e5f6 HTTP/1.1'],
    ['URL-encoded value', 'GET /cb?token=abc%2Fdef123xyz HTTP/1.1'],
    ['unquoted YAML value, run-together name (the 3c3 miss)', 'apikey: abcd1234efgh5678'],
    ['keyword argument, two-word compound', 'connect(api_key=abc123def456)'],
    ['second assignment on an export line', 'export FOO=1 SECRET_KEY=abcdefgh12345678'],
    ['Go short assignment, unquoted', 'token := abc123def456'],
    ['after a dot', 'config.apiKey=a1b2c3d4e5f6'],
    ['lower-case name in a sentence', 'log in with password=correct4horse then'],
    ['header-style name', 'x-api-key: a1b2c3d4e5f6g7h8'],
    ['upper-case name, letters only, ends at a comma', '[deploy] SIGNING_KEY=abcdefghijklmnop, region=eu'],
    // an earlier non-secret `name:` / `name=` whose value would run over the secret (review finding 1)
    ['after a non-secret name and colon', `Error: API_TOKEN=${LIVE} is invalid`],
    ['after a non-secret YAML key', 'env: password=abc123def456'],
    ['after a non-secret assignment whose value would run over it', 'set env=API_TOKEN=abcdefgh12345678 first'],
    // command-line flags (review finding 2)
    ['a --flag=value', 'mytool --token=abc123def456'],
    ['a --compound-flag=value', 'curl --api-key=abc123def456ghi https://api.example.com'],
    ['a --flag=value after another flag', 'psql --host=db --password=abc123def456'],
  ]

  test('an unquoted value set to a secret name anywhere in a line is matched', () => {
    for (const [name, line] of POSITIVES) expect([name, isSecretLine(line)]).toEqual([name, true])
  })

  test('every positive is still matched behind a non-secret prefix (no earlier match hides it)', () => {
    for (const [name, line] of POSITIVES) {
      for (const prefix of PREFIXES) expect([name, prefix, isSecretLine(prefix + line)]).toEqual([name, prefix, true])
    }
  })

  test('a dotted value is not 4c\'s: a mid-line JWT is still matched by the JWT rule', () => {
    const jwt = 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJ' + 'zdWIiOiIxMjM0In0' + '.' + 'abc123def'
    expect(isSecretLine(`set token=${jwt} before deploy`)).toBe(true)
  })

  test('ordinary code, prose and placeholders are not matched', () => {
    const negatives = [
      // not a secret name (a bare `key` is not one), or not a whole word
      'count=5', 'i=0', 'enabled: true',
      'sort_key=col2_desc_idx', 'cache_key: v2_users_list', 'primary_key: user_id_2024',
      '?page=2&limit=50&order=created2024desc', 'progress=50%25done',
      'monkey=banana12bread', 'tokens=abc123def456', 'keyPrefix=abq2queue1x', 'mytoken=abc123def456',
      'the 1password=desktop8app setting', '2-token=abc123def456',
      // not an assignment
      'if (token==abc123def456) return', 'token != abc123def456', 'token => abc123def456', 'token >= abc123def456',
      'Token::abc123def45', 'open vault-token://abc123def456 in the app',
      // too short
      'set API_TOKEN=abc1234 now', 'apikey: abc1234',
      // no digit: a lower-case name, or any name before `:`
      'access_token: required', 'DB_PASSWORD: required in production', 'password=placeholder',
      'secret: SecretManagerClient',
      // a type-shaped value after `:`
      'secret: Uint8Array', 'token: Base64String', 'apiKey: ApiKey2Config',
      // a dotted reference or a call
      'token = config2024.token', 'apikey = getKey2024()',
      // 3c3 placeholders
      'set API_TOKEN=YOUR_TOKEN_HERE first', 'the example uses API_KEY=xxxxxxxxxxxx here',
      'api_key: your-api-key-123', 'run with TOKEN=${TOKEN} set', 'run with TOKEN=<token> set',
      'token: {{ token }}', 'login with password=$DB_PASSWORD', 'token: ...',
      // a Windows %NAME% reference, as $NAME and ${NAME} (a value that merely holds a % is still matched)
      'set API_TOKEN=%API_TOKEN_VALUE% first',
    ]
    for (const line of negatives) expect([line, isSecretLine(line)]).toEqual([line, false])
  })

  test('accepted false positives are matched (redacting them is the safe side)', () => {
    const falsePositives: [string, string][] = [
      ['a code identifier holding a digit', 'const token = tokenFromEnv2'],
      ['a TTL on a token name', 'cache TOKEN_TTL=3600seconds here'],
      ['a pagination token', 'next_page_token=CiAKGjBpNDd2'],
      ['commit prose after a colon', 'Fix SECRET_KEY: rotate2024keys'],
    ]
    for (const [name, line] of falsePositives) expect([name, isSecretLine(line)]).toEqual([name, true])
  })
})

describe('buildContextPack: secret lines', () => {
  const pad5 = (n: number) => String(n).padStart(5)
  const marked = (n: number, kind: '+' | '-' | ' ') => `${kind === '-' ? ' '.repeat(5) : pad5(n)} ${kind} ${REDACTED}`

  test('a key inside an ordinary file: the line is replaced whole, keeps its number, and is not citable', async () => {
    const lines = ['export const maps = {', `  apiKey: '${S.google}',`, '  zoom: 3,', '}']
    const { repo, made } = setup({ patch: added('src/maps.ts', lines), blobs: { 'src/maps.ts': fileOf(lines) } })
    const { pack } = await build(repo, made)
    expect(section(pack, 'Diff')).toContain(`${marked(2, '+')}\n`)
    expect(pack.text).not.toContain('AIza')
    expect(sorted(pack.diffRefs)).toEqual(['src/maps.ts:1', 'src/maps.ts:3', 'src/maps.ts:4'])
    expect(sorted(pack.codeRefs)).toEqual(['src/maps.ts:1', 'src/maps.ts:3', 'src/maps.ts:4'])
    expect(pack.omitted).toContain('src/maps.ts: 1 line redacted (possible secret)')
    expect(section(pack, 'Omitted')).toContain('- src/maps.ts: 1 line redacted (possible secret)')
  })

  test('a heavily edited .env rename (git sees a delete and a new file): the token line is redacted', async () => {
    const { repo, made } = setup({
      patch: deleted('.env.staging', [`API_TOKEN=${S.token}`, 'DEBUG=1', 'PORT=3000']) +
        added('config/app.ini', ['[server]', 'port = 8080', `API_TOKEN=${S.token}`, 'debug = false']),
    })
    const { pack } = await build(repo, made)
    expect(pack.omitted).toContain('.env.staging: secret file, omitted')
    expect(pack.text).not.toContain('tok_live')
    expect(section(pack, 'Diff')).toContain(marked(3, '+'))
    expect(sorted(pack.diffRefs)).toEqual(['config/app.ini:1', 'config/app.ini:2', 'config/app.ini:4'])
    expect(pack.omitted).toContain('config/app.ini: 1 line redacted (possible secret)')
  })

  test('removed and context lines are redacted too', async () => {
    const { repo, made } = setup({
      patch: modified('src/a.ts', hunk(1, 1, [` const stripe = '${S.stripe}'`, `-API_TOKEN=${S.token}`, '+const token = readSecret()'])),
    })
    const { pack } = await build(repo, made)
    expect(section(pack, 'Diff')).toContain(`${marked(1, ' ')}\n${marked(0, '-')}\n    2 + const token = readSecret()`)
    expect(pack.text).not.toContain('_live_')
    expect(sorted(pack.diffRefs)).toEqual(['src/a.ts:2'])
    expect(pack.omitted).toContain('src/a.ts: 2 lines redacted (possible secret)')
  })

  test('a line is matched in full before the 400-character display cut', async () => {
    const { repo, made } = setup({ patch: added('src/long.ts', [`${'x'.repeat(450)} '${S.stripe}'`, 'ok']) })
    const { pack } = await build(repo, made)
    expect(section(pack, 'Diff')).toContain(`${marked(1, '+')}\n`)
    expect(sorted(pack.diffRefs)).toEqual(['src/long.ts:2'])
  })

  test('a key block in a hunk: every line from BEGIN to END is redacted', async () => {
    const { repo, made } = setup({
      patch: modified('src/keys.ts', hunk(1, 1, [' export const pem = `', `+${BEGIN}`, ...BODY.map(b => `+${b}`), `+${END}`, ' `'])),
    })
    const { pack } = await build(repo, made)
    expect(pack.text).not.toContain('PRIVATE KEY')
    for (const line of BODY) expect(pack.text).not.toContain(line)
    expect(sorted(pack.diffRefs)).toEqual(['src/keys.ts:1', 'src/keys.ts:7'])
    expect(section(pack, 'Diff')).toContain([2, 3, 4, 5, 6].map(n => marked(n, '+')).join('\n'))
    expect(pack.omitted).toContain('src/keys.ts: 5 lines redacted (possible secret)')
  })

  test('a hunk that starts inside a block (END only) is redacted back to its start', async () => {
    const { repo, made } = setup({
      patch: modified('src/keys.ts', hunk(10, 10, [` ${BODY[1]}`, ` ${BODY[2]}`, ` ${END}`, ' `', '-const old = 1', '+const changed = 2'])),
    })
    const { pack } = await build(repo, made)
    expect(pack.text).not.toContain(BODY[1]!)
    expect(pack.text).not.toContain(BODY[2]!)
    expect(sorted(pack.diffRefs)).toEqual(['src/keys.ts:13', 'src/keys.ts:14'])
    expect(pack.omitted).toContain('src/keys.ts: 3 lines redacted (possible secret)')
  })

  test('a BEGIN with no END in its hunk is redacted to the end of the hunk', async () => {
    const { repo, made } = setup({
      patch: modified('src/keys.ts', hunk(1, 1, [' const a = 1', `+${BEGIN}`, `+${BODY[0]}`, `+${BODY[1]}`])),
    })
    const { pack } = await build(repo, made)
    expect(pack.text).not.toContain(BODY[0]!)
    expect(pack.text).not.toContain(BODY[1]!)
    expect(sorted(pack.diffRefs)).toEqual(['src/keys.ts:1'])
    expect(pack.omitted).toContain('src/keys.ts: 3 lines redacted (possible secret)')
  })

  test('a key block in surrounding code is redacted over the whole blob; one count per file', async () => {
    const password = `  password: 'correct-horse-battery',`
    const after = numbered(40)
    after.splice(4, 6, 'const pem = `', BEGIN, BODY[0]!, BODY[1]!, END, '`') // lines 5..10
    after.splice(19, 1, 'changed 20', password) // lines 20, 21
    const { repo, made } = setup({
      patch: modified('src/server.ts', hunk(20, 20, ['-line 20', '+changed 20', `+${password}`])),
      blobs: { 'src/server.ts': fileOf(after) },
    })
    const { pack } = await build(repo, made)
    const around = section(pack, 'Surrounding code at this commit')
    expect(around).toContain(`    5 | const pem = \`\n    6 | ${REDACTED}\n`)
    expect(around).toContain(`    9 | ${REDACTED}\n   10 | \`\n`)
    expect(pack.text).not.toContain(BODY[0]!)
    expect(pack.text).not.toContain('correct-horse')
    expect(sorted(pack.diffRefs)).toEqual(['src/server.ts:20'])
    const expected = refs('src/server.ts', 1, 41).filter(ref => !/:(6|7|8|9|21)$/.test(ref))
    expect(sorted(pack.codeRefs)).toEqual(expected.sort())
    expect(pack.omitted).toContain('src/server.ts: 5 lines redacted (possible secret)')
  })

  test('the commit message: secret lines of the subject and body are redacted', async () => {
    const { repo, made } = setup({
      subject: 'Add maps',
      body: `Uses the key ${S.google} for now.\nRotate it later.\nAPI_TOKEN=${S.token}`,
      patch: added('src/a.ts', ['x']),
    })
    const { pack } = await build(repo, made)
    expect(section(pack, 'Commit message')).toContain(`Add maps\n\n${REDACTED}\nRotate it later.\n${REDACTED}`)
    expect(pack.text).not.toContain('AIza')
    expect(pack.omitted).toContain('commit message: 2 lines redacted (possible secret)')
  })

  test('a hunk label holding a secret is replaced', async () => {
    const { repo, made } = setup({
      patch: modified('src/a.ts', hunk(1, 1, ['-a', '+b'], ` const API_KEY = '${S.google}'`)),
    })
    const { pack } = await build(repo, made)
    expect(section(pack, 'Diff')).toContain(`@@ -1,1 +1,1 @@ ${REDACTED}\n`)
    expect(pack.text).not.toContain('AIza')
    expect(sorted(pack.diffRefs)).toEqual(['src/a.ts:1'])
    expect(pack.omitted).toContain('src/a.ts: 1 line redacted (possible secret)')
  })

  test('recent subjects holding a secret are redacted', async () => {
    const repo = makeRepo(TOP)
    commit(repo, { subject: `Use ${S.github} for CI`, committedAt: '2026-10-01T00:00:00Z' })
    commit(repo, { subject: 'Plain change', committedAt: '2026-10-02T00:00:00Z' })
    const latest = commit(repo, { subject: 'This one', committedAt: '2026-10-03T00:00:00Z' })
    const { pack } = await build(repo, latest)
    expect(section(pack, 'Recent commits (newest first)')).toContain(`- Plain change\n- ${REDACTED}`)
    expect(pack.text).not.toContain('ghp_')
    expect(pack.omitted).toContain('recent commits: 1 line redacted (possible secret)')
  })

  test('repo docs: secret lines and key blocks are redacted, counted per doc', async () => {
    const { repo, made } = setup({
      blobs: {
        'SPEC.md': `# Spec\nanon key: ${S.jwt}\nrules\n`,
        'README.md': `# Readme\n${BEGIN}\n${BODY[0]}\n${END}\nend\n`,
      },
    })
    const { pack } = await build(repo, made)
    const docs = section(pack, 'Repo docs at this commit')
    expect(docs).toContain(`### SPEC.md\n# Spec\n${REDACTED}\nrules`)
    expect(docs).toContain(`### README.md\n# Readme\n${REDACTED}\n${REDACTED}\n${REDACTED}\nend`)
    expect(pack.text).not.toContain('eyJ')
    expect(pack.text).not.toContain(BODY[0]!)
    expect(pack.omitted).toContain('SPEC.md: 1 line redacted (possible secret)')
    expect(pack.omitted).toContain('README.md: 3 lines redacted (possible secret)')
  })

  test('a mid-line assignment (4c) is redacted in the message, recent subjects, diff, surrounding code and docs', async () => {
    const sentence = `Deploy with API_TOKEN=${S.token} set first.`
    const repo = makeRepo(TOP)
    commit(repo, { subject: `Note: ${sentence}`, committedAt: '2026-10-01T00:00:00Z' })
    const made = commit(repo, {
      subject: 'Add deploy notes',
      body: `Context.\n${sentence}`,
      committedAt: '2026-10-02T00:00:00Z',
      patch: modified('src/deploy.ts', hunk(1, 1, [' line 1', '-old 2', `+${sentence}`, ' line 3'])),
      blobs: { 'src/deploy.ts': fileOf(['line 1', sentence, 'line 3', 'line 4', sentence]), 'SPEC.md': `# Spec\n${sentence}\nrules\n` },
    })
    const { pack } = await build(repo, made)
    expect(pack.text).not.toContain(S.token)
    expect(section(pack, 'Commit message')).toContain(`Add deploy notes\n\nContext.\n${REDACTED}`)
    expect(section(pack, 'Recent commits (newest first)')).toContain(`- ${REDACTED}`)
    expect(section(pack, 'Diff')).toContain(`${marked(2, '+')}\n`)
    expect(section(pack, 'Surrounding code at this commit')).toContain(`    5 | ${REDACTED}`)
    expect(section(pack, 'Repo docs at this commit')).toContain(`### SPEC.md\n# Spec\n${REDACTED}\nrules`)
    for (const entry of [
      'commit message: 1 line redacted (possible secret)',
      'recent commits: 1 line redacted (possible secret)',
      'src/deploy.ts: 2 lines redacted (possible secret)',
      'SPEC.md: 1 line redacted (possible secret)',
    ]) expect(pack.omitted).toContain(entry)
  })

  test('a pack with redactions is byte-identical when rebuilt; a clean pack lists no redactions', async () => {
    const { repo, made } = setup({
      body: `API_TOKEN=${S.token}`,
      patch: modified('src/a.ts', hunk(1, 1, ['-a', `+const anon = '${S.jwt}'`, '+b'])),
      blobs: { 'src/a.ts': `const anon = '${S.jwt}'\nb\n`, 'SPEC.md': `x\n${S.supabase}\n` },
    })
    const one = await build(repo, made)
    const two = await build(repo, made)
    expect(two.pack.text).toBe(one.pack.text)
    expect(two.pack.omitted).toEqual(one.pack.omitted)
    expect(one.pack.omitted.filter(line => line.includes('redacted')).length).toBe(3)

    const clean = setup({ patch: added('src/a.ts', ['const key = getKey()']) })
    const { pack } = await build(clean.repo, clean.made)
    expect(pack.omitted.filter(line => line.includes('redacted'))).toEqual([])
    expect(pack.text).not.toContain(REDACTED)
  })
})
