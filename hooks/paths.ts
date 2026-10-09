import { git } from './git.ts'
import type { Run } from './git.ts'

// Injected so tests can fake it; the plugin passes $.fs.exists.
export type Exists = (path: string) => Promise<boolean>

export type HomeEnv = { USERPROFILE?: string; HOME?: string }

export type DataDirVerdict = { isSafe: true } | { isSafe: false; reason: string }

const FOLDER = '.after-build-quiz'

export const toForwardSlashes = (path: string): string => {
  const slashed = path.replace(/\\/g, '/')
  return /^[A-Za-z]:\/$/.test(slashed) || slashed === '/' ? slashed : slashed.replace(/\/+$/, '')
}

export const isAbsolute = (path: string): boolean => /^[A-Za-z]:\//.test(path) || path.startsWith('/')

export const resolveDataDir = (setting: string, env: HomeEnv): string => {
  if (setting !== '') {
    const dir = toForwardSlashes(setting)
    if (!isAbsolute(dir)) {
      throw new Error(`after-build-quiz: dataDir must be an absolute path, got "${setting}"`)
    }
    return dir
  }
  const home = env.USERPROFILE || env.HOME
  if (!home) throw new Error('after-build-quiz: neither USERPROFILE nor HOME is set; set dataDir')
  return `${toForwardSlashes(home)}/${FOLDER}`
}

const parentOf = (path: string): string | undefined => {
  if (/^[A-Za-z]:\/$/.test(path) || path === '/') return undefined
  const cut = path.lastIndexOf('/')
  if (cut < 0) return undefined
  const parent = path.slice(0, cut)
  if (parent === '') return '/'
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent
}

const nearestExisting = async (dir: string, exists: Exists): Promise<string | undefined> => {
  for (let at: string | undefined = dir; at !== undefined; at = parentOf(at)) {
    if (await exists(at)) return at
  }
  return undefined
}

// Quiz data must never land in a repo: refuse when dataDir (or, before it
// exists, its nearest existing parent) is inside a git work tree.
export const checkDataDir = async (
  dataDir: string,
  io: { run: Run; exists: Exists },
): Promise<DataDirVerdict> => {
  const probe = await nearestExisting(dataDir, io.exists)
  if (probe === undefined) return { isSafe: false, reason: `no existing folder on the path to ${dataDir}` }
  try {
    const result = await git(io.run, probe, ['rev-parse', '--is-inside-work-tree'])
    if (result.exitCode === 0 && result.stdout.trim() === 'true') {
      return { isSafe: false, reason: `${dataDir} is inside a git work tree` }
    }
    return { isSafe: true }
  } catch (error) {
    return { isSafe: false, reason: `could not run git to check ${dataDir}: ${String(error)}` }
  }
}
