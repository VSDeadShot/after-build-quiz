import { authorArgs, commitsIn, findHead, logMine, markSeen, queueWorthy, sightingKey } from './detect.ts'
import type { Head } from './detect.ts'
import type { Run } from './git.ts'
import { isAbsolute, normalizeDir } from './paths.ts'
import type { Exists } from './paths.ts'
import { loadQueue, oneLine, saveQueue } from './queue.ts'
import type { Queue, QueueIO } from './queue.ts'

// The session-start catch-up for commits made outside Claude Code (terminal,
// IDE): for the session repo and the most recently active known repos, take
// my commits in lastSeen..HEAD on the current branch. First sight of a repo
// or branch, and a pruned lastSeen, only record a baseline. See SPEC behaviour 1.

export const SWEEP_REPO_CAP = 20 // the session repo counts within it

export type SweepDeps = {
  run: Run
  io: QueueIO
  exists: Exists
  dataDir: string
  isWindows: boolean
  minChangedLines: number
  queueCap: number
}

export type SweepInput = { sessionCwd: string; now: string }

export type SweepOutcome = { queued: number; queue?: Queue; notice?: string; errors: string[] }

const rootOf = (key: string): string => key.slice(0, key.lastIndexOf('::'))

const timeOf = (when: string | undefined): number => {
  const time = when === undefined ? NaN : Date.parse(when)
  return Number.isNaN(time) ? 0 : time
}

// Known repos other than the session's (already tried, found or not), most
// recently active first.
const otherRoots = (queue: Queue, session: readonly (string | undefined)[], limit: number): string[] =>
  [...new Set(Object.keys(queue.lastSeen).map(rootOf))]
    .filter(root => !session.includes(root))
    .sort((a, b) => timeOf(queue.seenAt[b]) - timeOf(queue.seenAt[a]) || a.localeCompare(b))
    .slice(0, Math.max(0, limit))

export const sweepRepos = async (deps: SweepDeps, input: SweepInput): Promise<SweepOutcome> => {
  const { run, io, dataDir, isWindows } = deps
  const errors: string[] = []
  try {
    const loaded = await loadQueue(io, dataDir, input.now)
    const withNotice = (outcome: SweepOutcome): SweepOutcome =>
      loaded.notice === undefined ? outcome : { ...outcome, notice: loaded.notice }
    if (!loaded.isWritable) return withNotice({ queued: 0, errors })

    let queue = loaded.queue
    let queued = 0
    let isChanged = false

    const sweepOne = async (head: Head, isSession: boolean) => {
      const mark = () => {
        queue = markSeen(queue, head, input.now)
        isChanged = true
      }
      const lastSeen = queue.lastSeen[sightingKey(head)]
      if (lastSeen === undefined) return mark() // first sight of this repo or branch: baseline only
      if (lastSeen === head.sha) {
        if (isSession) mark() // nothing new, but the session repo is active now
        return
      }
      const log = await logMine(run, head.top, deps.queueCap, await authorArgs(run, head.top), [`${lastSeen}..HEAD`])
      if (log.exitCode !== 0) return mark() // lastSeen pruned: new baseline, no guessing

      // An outside amend: the commit we last saw is pending, and a new commit
      // has its parent. 2f's isAmend rule replaces the stale entry.
      const replaced = queue.pending.find(entry => entry.hash === lastSeen && entry.repo === head.top)
      const result = await queueWorthy(run, head.top, queue, commitsIn(log.stdout), {
        source: 'sweep',
        now: input.now,
        minChangedLines: deps.minChangedLines,
        queueCap: deps.queueCap,
        isAmend: made => replaced !== undefined && made.parents[0] === replaced.parent,
      })
      queue = result.queue
      queued += result.queued
      mark()
    }

    let sessionTop: string | undefined
    const sessionDir = normalizeDir(input.sessionCwd, isWindows)
    if (sessionDir !== undefined && isAbsolute(sessionDir)) {
      try {
        const head = await findHead(run, [sessionDir], isWindows)
        if (head !== undefined) {
          sessionTop = head.top
          await sweepOne(head, true)
        }
      } catch (error) {
        errors.push(`${sessionDir}: ${oneLine(String(error))}`)
      }
    }

    for (const root of otherRoots(queue, [sessionTop, sessionDir], SWEEP_REPO_CAP - (sessionTop === undefined ? 0 : 1))) {
      try {
        if (!(await deps.exists(root))) continue // folder gone: no git call
        const head = await findHead(run, [root], isWindows)
        if (head === undefined || head.top === sessionTop) continue // no longer a repo, or no commits
        await sweepOne(head, false)
      } catch (error) {
        errors.push(`${root}: ${oneLine(String(error))}`)
      }
    }

    if (!isChanged) return withNotice({ queued, errors })
    const saved = await saveQueue(io, dataDir, queue)
    return withNotice(saved.isSaved ? { queued, queue: saved.queue, errors } : { queued, errors })
  } catch (error) {
    errors.push(oneLine(String(error)))
    return { queued: 0, errors }
  }
}
