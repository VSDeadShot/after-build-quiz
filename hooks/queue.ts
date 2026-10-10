import { git } from './git.ts'
import type { Run } from './git.ts'
import type { Exists } from './paths.ts'

// The pending-quiz queue: pure transforms plus crash-safe load/save over an
// injected fs (the plugin passes $.fs). See SPEC behaviour 1–3 and "Storage".
// Nothing here throws into the user's workflow.

export type QueueEntry = {
  repo: string
  repoName: string
  hash: string
  parent: string | null // first parent; an amend keeps the parent of the commit it replaces
  subject: string
  committedAt: string // committer date (%cI): what "newest" and "oldest" mean
  queuedAt: string
  source: 'claude-code' | 'sweep'
  codeLines: number
  codeFiles: number
}

export type ExpiredEntry = {
  repo: string
  repoName: string
  hash: string
  subject: string
  reason: 'cap' | 'missing'
  detail?: string
  expiredAt: string
}

export type Queue = {
  version: 1
  seq: number // incremented on every save; on load the higher seq wins
  pending: QueueEntry[] // sorted oldest → newest by committedAt
  expired: ExpiredEntry[] // the last EXPIRED_KEPT
  expiredCount: number
  lastSeen: Record<string, string> // `<repo root>::<branch>` → last commit seen
  seenAt: Record<string, string> // repo root → last activity (ISO); ranks repos for the sweep
}

export type QueueIO = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
}

export type ParsedCommit = {
  hash: string
  parents: string[]
  authoredAt: string
  committedAt: string
  subject: string
}

const EXPIRED_KEPT = 50

export const emptyQueue = (): Queue => ({
  version: 1, seq: 0, pending: [], expired: [], expiredCount: 0, lastSeen: {}, seenAt: {},
})

// `git log -1 --format=<this>`: hash, parents, author date, committer date, subject.
export const COMMIT_FORMAT = '%H%x1f%P%x1f%aI%x1f%cI%x1f%s'

export const parseCommitLine = (stdout: string): ParsedCommit | undefined => {
  const [hash, parents, authoredAt, committedAt, ...subject] = (stdout.split(/\r?\n/)[0] ?? '').split('\x1f')
  if (hash === undefined || !/^[0-9a-f]{40,64}$/.test(hash) || committedAt === undefined || authoredAt === undefined) {
    return undefined
  }
  return {
    hash,
    parents: (parents ?? '').split(' ').filter(parent => parent !== ''),
    authoredAt,
    committedAt,
    subject: subject.join('\x1f'),
  }
}

const timeOf = (when: string): number => {
  const time = Date.parse(when)
  return Number.isNaN(time) ? 0 : time
}

const byCommitTime = (a: QueueEntry, b: QueueEntry): number =>
  timeOf(a.committedAt) - timeOf(b.committedAt) || timeOf(a.queuedAt) - timeOf(b.queuedAt)

const expire = (
  queue: Queue,
  entry: QueueEntry,
  reason: ExpiredEntry['reason'],
  now: string,
  detail?: string,
): Queue => {
  const record: ExpiredEntry = {
    repo: entry.repo, repoName: entry.repoName, hash: entry.hash, subject: entry.subject, reason,
    ...(detail === undefined ? {} : { detail }),
    expiredAt: now,
  }
  return {
    ...queue,
    pending: queue.pending.filter(pending => pending.hash !== entry.hash),
    expired: [...queue.expired, record].slice(-EXPIRED_KEPT),
    expiredCount: queue.expiredCount + 1,
  }
}

export const enqueue = (
  queue: Queue,
  entry: QueueEntry,
  options: { isAmend: boolean; cap: number; now: string },
): Queue => {
  if (queue.pending.some(pending => pending.hash === entry.hash)) return queue

  // An amended commit has the same parent as the commit it replaces.
  const kept = options.isAmend && entry.parent !== null
    ? queue.pending.filter(pending => !(pending.repo === entry.repo && pending.parent === entry.parent))
    : queue.pending

  let next: Queue = { ...queue, pending: [...kept, entry].sort(byCommitTime) }
  while (next.pending.length > options.cap) next = expire(next, next.pending[0]!, 'cap', options.now)
  return next
}

// Newest pending commit that still exists. Missing ones expire on the way;
// the one returned stays pending (a skipped quiz is still there next time).
export const selectNewest = async (
  queue: Queue,
  check: { run: Run; exists: Exists },
  now: string,
): Promise<{ queue: Queue; entry?: QueueEntry }> => {
  let current = queue
  for (const candidate of [...queue.pending].reverse()) {
    try {
      if (!(await check.exists(candidate.repo))) {
        current = expire(current, candidate, 'missing', now, 'repo folder not found')
        continue
      }
      const found = await git(check.run, candidate.repo, ['cat-file', '-e', `${candidate.hash}^{commit}`])
      if (found.exitCode === 0) return { queue: current, entry: candidate }
      current = expire(current, candidate, 'missing', now, 'commit not found')
    } catch {
      return { queue: current, entry: candidate } // could not verify: never expire on uncertainty
    }
  }
  return { queue: current }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isEntry = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.repo === 'string' && typeof value.hash === 'string' && typeof value.committedAt === 'string' &&
  (typeof value.parent === 'string' || value.parent === null)

const isQueue = (value: unknown): value is Queue =>
  isRecord(value) &&
  value.version === 1 &&
  Number.isInteger(value.seq) && (value.seq as number) >= 0 &&
  Array.isArray(value.pending) && value.pending.every(isEntry) &&
  Array.isArray(value.expired) && value.expired.every(isRecord) &&
  Number.isInteger(value.expiredCount) &&
  isRecord(value.lastSeen) && Object.values(value.lastSeen).every(hash => typeof hash === 'string') &&
  (value.seenAt === undefined ||
    (isRecord(value.seenAt) && Object.values(value.seenAt).every(when => typeof when === 'string')))

type FileState =
  | { state: 'absent' }
  | { state: 'unreadable'; reason: string }
  | { state: 'invalid'; text: string }
  | { state: 'valid'; queue: Queue }

export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

const readState = async (io: QueueIO, path: string): Promise<FileState> => {
  let text: string
  try {
    if (!(await io.exists(path))) return { state: 'absent' }
    text = await io.read(path)
  } catch (error) {
    return { state: 'unreadable', reason: oneLine(String(error)) }
  }
  try {
    const value: unknown = JSON.parse(text)
    // a file from before seenAt existed loads with an empty one
    return isQueue(value) ? { state: 'valid', queue: { ...value, seenAt: value.seenAt ?? {} } } : { state: 'invalid', text }
  } catch {
    return { state: 'invalid', text }
  }
}

const filesOf = (dataDir: string) => ({ main: `${dataDir}/queue.json`, tmp: `${dataDir}/queue.json.tmp` })

// isReadOnly: never write, not even the copy-aside (the status line only reads).
export const loadQueue = async (
  io: QueueIO,
  dataDir: string,
  now: string,
  options: { isReadOnly?: boolean } = {},
): Promise<{ queue: Queue; notice?: string; isWritable: boolean }> => {
  const { main, tmp } = filesOf(dataDir)
  const mainState = await readState(io, main)
  const tmpState = await readState(io, tmp)

  const valid = [mainState, tmpState].flatMap(file => (file.state === 'valid' ? [file.queue] : []))
  if (valid.length > 0) {
    const newest = valid.reduce((best, queue) => (queue.seq > best.seq ? queue : best))
    return { queue: newest, isWritable: true }
  }

  if (mainState.state === 'unreadable') {
    return {
      queue: emptyQueue(),
      isWritable: false,
      notice: `after-build-quiz: could not read queue.json (${mainState.reason}); using an empty queue and not overwriting it this session`,
    }
  }

  if (mainState.state === 'invalid' && options.isReadOnly === true) {
    return {
      queue: emptyQueue(),
      isWritable: false,
      notice: 'after-build-quiz: queue.json is corrupt; it will be copied aside at the next commit',
    }
  }

  if (mainState.state === 'invalid') {
    const asideName = `queue.corrupt-${now.replace(/[:.]/g, '-')}.json`
    try {
      await io.write(`${dataDir}/${asideName}`, mainState.text)
    } catch {
      return {
        queue: emptyQueue(),
        isWritable: false,
        notice: 'after-build-quiz: queue.json is corrupt and could not be copied aside; not overwriting it this session',
      }
    }
    return {
      queue: emptyQueue(),
      isWritable: true,
      notice: `after-build-quiz: queue.json was corrupt; saved it as ${asideName} and started a fresh queue`,
    }
  }

  return { queue: emptyQueue(), isWritable: true }
}

// Crash-safe without rename ($.fs has none): the full queue goes to the tmp
// copy first, then to queue.json, so at every moment one of them is complete;
// loadQueue takes the valid one with the higher seq.
export const saveQueue = async (
  io: QueueIO,
  dataDir: string,
  queue: Queue,
): Promise<{ isSaved: boolean; queue: Queue }> => {
  const { main, tmp } = filesOf(dataDir)
  const next: Queue = { ...queue, seq: queue.seq + 1 }
  const text = `${JSON.stringify(next, null, 2)}\n`
  try {
    await io.write(tmp, text)
    await io.write(main, text)
    return { isSaved: true, queue: next }
  } catch {
    return { isSaved: false, queue }
  }
}

// The status line: "N quizzes pending", or nothing when none are.
export const statusText = (queue: Queue): string | undefined => {
  const count = queue.pending.length
  if (count === 0) return undefined
  return count === 1 ? '1 quiz pending' : `${count} quizzes pending`
}
