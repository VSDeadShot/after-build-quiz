import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

// Injected so tests can fake it; the plugin passes $.process.run.
export type Run = (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>

// The plugin's only way to run git. Read-only subcommands alone, checked before
// anything runs; see SPEC "Never" and AGENTS "Hard rules". Do not widen.
export class GitRefused extends Error {
  constructor(args: readonly string[], why: string) {
    super(`after-build-quiz: refused git ${args.join(' ')}: ${why}`)
    this.name = 'GitRefused'
  }
}

const READ_ONLY = new Set(['rev-parse', 'log', 'show', 'cat-file', 'config'])

// log/show run diff drivers from .gitattributes unless told not to
const NO_DRIVERS = ['--no-ext-diff', '--no-textconv']

const refusal = (args: readonly string[]): string | undefined => {
  const [subcommand, ...rest] = args
  if (subcommand === undefined) return 'no subcommand'
  if (subcommand.startsWith('-')) return 'global options are not allowed'
  if (!READ_ONLY.has(subcommand)) return `${subcommand} is not read-only`

  if (subcommand === 'config') {
    return rest.length === 2 && rest[0] === '--get' ? undefined : 'only config --get <key> is allowed'
  }
  if (subcommand === 'log' || subcommand === 'show') {
    const bad = rest.find(arg =>
      /^--output(=|$)/.test(arg) || /^-o/.test(arg) || arg === '--ext-diff' || arg === '--textconv',
    )
    return bad === undefined ? undefined : `${bad} can write files or run drivers`
  }
  if (subcommand === 'cat-file') {
    const bad = rest.find(arg => arg === '--textconv' || arg === '--filters')
    return bad === undefined ? undefined : `${bad} runs drivers`
  }
  return undefined
}

export const git = async (
  run: Run,
  repo: string,
  args: readonly string[],
  init?: ProcessRunInit,
): Promise<ProcessRunResult> => {
  const why = refusal(args)
  if (why !== undefined) throw new GitRefused(args, why)

  const [subcommand, ...rest] = args as [string, ...string[]]
  const withGuards = subcommand === 'log' || subcommand === 'show' ? [subcommand, ...NO_DRIVERS, ...rest] : args
  return run(['git', '-C', repo, '--no-pager', ...withGuards], init)
}
