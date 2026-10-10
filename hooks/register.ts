import type { EngineInterface, Register } from 'claude-code'

import { detectCommits, parseCommit } from './detect.ts'
import type { DetectInput } from './detect.ts'
import { checkDataDir, resolveDataDir } from './paths.ts'
import type { DataDirVerdict } from './paths.ts'
import { loadQueue, statusText } from './queue.ts'
import type { QueueIO } from './queue.ts'
import { readSettings } from './settings.ts'
import type { Settings } from './settings.ts'
import { sweepRepos } from './sweep.ts'

// Hard rule (AGENTS): no hook throws, blocks or noticeably slows a command.
// A commit command costs two in-process calls before it runs; everything else
// happens on a timer after its result has gone back.
//
// The engine requires every function `$` is passed to be declared at the top
// of this file, so the per-load state travels in `State`.

type State = {
  settings: Settings
  trackedCwd: string | undefined
  detections: Promise<void> // one at a time: no in-process races on the queue file
  dataDirVerdict: DataDirVerdict | undefined
  shownOnce: Set<string>
}

const oneLine = (error: unknown): string => String(error).replace(/\s+/g, ' ').trim()

function noticeOnce($: EngineInterface, state: State, kind: string, text: string) {
  if (state.shownOnce.has(kind)) return
  state.shownOnce.add(kind)
  $.ui.log(text)
}

function debug($: EngineInterface, text: string) {
  $.ui.log(`after-build-quiz: ${text}`, { to: 'debug' })
}

function ioOf($: EngineInterface): QueueIO {
  return {
    read: async path => {
      const text = await $.fs.read(path)
      if (typeof text !== 'string') throw new Error(`${path} did not read as text`)
      return text
    },
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
  }
}

async function dataDirOf($: EngineInterface, state: State): Promise<string> {
  return resolveDataDir(state.settings.dataDir, {
    USERPROFILE: await $.env.get('USERPROFILE'),
    HOME: await $.env.get('HOME'),
  })
}

async function isoNow($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString()
}

// The data folder, once it is known to be outside any repo; undefined means
// do not write (told once if it is inside a repo, retried if it could not be checked).
async function safeDataDir($: EngineInterface, state: State): Promise<string | undefined> {
  const dataDir = await dataDirOf($, state)
  const verdict = state.dataDirVerdict ?? await checkDataDir(dataDir, {
    run: (argv, init) => $.process.run(argv, init),
    exists: path => $.fs.exists(path),
  })
  if (!verdict.isSafe) {
    if (!verdict.isInsideRepo) {
      debug($, `data folder not checked: ${verdict.reason}`) // try again next time
      return undefined
    }
    state.dataDirVerdict = verdict
    noticeOnce($, state, 'dataDir', `after-build-quiz: ${dataDir} is inside a git repo; quizzes are not saved there. Set dataDir to a folder outside any repo.`)
    return undefined
  }
  state.dataDirVerdict = verdict
  return dataDir
}

async function detectAfter($: EngineInterface, state: State, input: Omit<DetectInput, 'now'>) {
  try {
    const dataDir = await safeDataDir($, state)
    if (dataDir === undefined) return

    const outcome = await detectCommits({
      run: (argv, init) => $.process.run(argv, init),
      io: ioOf($),
      dataDir,
      isWindows: /^[A-Za-z]:[\\/]/.test(input.sessionCwd),
      minChangedLines: state.settings.minChangedLines,
      queueCap: state.settings.queueCap,
    }, { ...input, now: await isoNow($) })
    if (outcome.notice !== undefined) noticeOnce($, state, 'queue', outcome.notice)
    if (outcome.queue !== undefined) $.ui.status(statusText(outcome.queue))
  } catch (error) {
    debug($, `commit detection failed: ${oneLine(error)}`)
  }
}

async function sweepAfter($: EngineInterface, state: State, sessionCwd: string) {
  try {
    const dataDir = await safeDataDir($, state)
    if (dataDir === undefined) return

    const outcome = await sweepRepos({
      run: (argv, init) => $.process.run(argv, init),
      io: ioOf($),
      exists: path => $.fs.exists(path),
      dataDir,
      isWindows: /^[A-Za-z]:[\\/]/.test(sessionCwd),
      minChangedLines: state.settings.minChangedLines,
      queueCap: state.settings.queueCap,
    }, { sessionCwd, now: await isoNow($) })
    for (const error of outcome.errors) debug($, `sweep: ${error}`)
    if (outcome.notice !== undefined) noticeOnce($, state, 'queue', outcome.notice)
    if (outcome.queue !== undefined) $.ui.status(statusText(outcome.queue))
  } catch (error) {
    debug($, `sweep failed: ${oneLine(error)}`)
  }
}

async function watch<R>($: EngineInterface, state: State, command: string, isBackground: boolean, run: () => Promise<R>): Promise<R> {
  const parsed = isBackground ? undefined : parseCommit(command)
  if (parsed === undefined) return run()
  const before = {
    command: parsed,
    trackedCwd: state.trackedCwd,
    sessionCwd: await $.session.cwd(),
    startedAt: await $.clock.now(),
  }
  const ran = await run()
  $.clock.after(0, () => {
    state.detections = state.detections.then(() => detectAfter($, state, before)).catch(() => {})
  })
  return ran
}

// The status line reads the queue file only: no git, no model, no writes.
async function showStatus($: EngineInterface, state: State) {
  try {
    const loaded = await loadQueue(ioOf($), await dataDirOf($, state), await isoNow($), { isReadOnly: true })
    if (loaded.notice !== undefined) noticeOnce($, state, 'queue', loaded.notice)
    $.ui.status(statusText(loaded.queue))
  } catch (error) {
    debug($, `status line not set: ${oneLine(error)}`)
  }
}

export const register: Register = (on, options) => {
  const state: State = {
    settings: readSettings(options),
    trackedCwd: undefined,
    detections: Promise.resolve(),
    dataDirVerdict: undefined,
    shownOnce: new Set(),
  }

  on('tool.call', { tool: 'Bash' }, ($, e, next) =>
    watch($, state, e.command, e.run_in_background === true, () => next(e)),
  ).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'PowerShell' }, ($, e, next) =>
    watch($, state, e.command, e.run_in_background === true, () => next(e)),
  ).catch(($, e, next) => next(e))

  on('classic.CwdChanged', ($, e, next) => {
    state.trackedCwd = e.new_cwd
    return next(e)
  }).catch(($, e, next) => next(e))

  // The status from the queue file first; the catch-up sweep after, on a timer,
  // in the same one-at-a-time line as commit detections.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await showStatus($, state)
    const sessionCwd = e.cwd
    $.clock.after(0, () => {
      state.detections = state.detections.then(() => sweepAfter($, state, sessionCwd)).catch(() => {})
    })
    return started
  }).catch(($, e, next) => next(e))
}
