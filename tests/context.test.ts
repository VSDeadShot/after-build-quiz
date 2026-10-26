import { describe, expect, test } from 'claude-code/testing'

import { buildContextPack } from '../hooks/context.ts'
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
