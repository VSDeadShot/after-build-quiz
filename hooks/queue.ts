import { git } from './git.ts'
import type { Run } from './git.ts'
import type { Exists, SafeDataDir } from './paths.ts'
import { loadStore, peekStore, saveStore } from './store.ts'
import type { StoreFile, StoreIO } from './store.ts'

export { oneLine } from './store.ts'

// The pending-quiz queue: pure transforms plus crash-safe load/save over an
// injected fs (the plugin passes $.fs; the storage itself is store.ts). See
// SPEC behaviour 1–3 and "Storage". Nothing here throws into the user's workflow.

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
  skippedAt?: string // when `/quiz skip` last passed it over; absent: never skipped
}

// A commit by where it lives: the same hash in another repo is another commit.
export type CommitRef = { repo: string; hash: string }

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

export type QueueIO = StoreIO

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
  options: { isAmend: boolean; cap: number; now: string; keep?: CommitRef },
): Queue => {
  if (queue.pending.some(pending => pending.hash === entry.hash)) return queue

  // An amended commit has the same parent as the commit it replaces.
  const kept = options.isAmend && entry.parent !== null
    ? queue.pending.filter(pending => !(pending.repo === entry.repo && pending.parent === entry.parent))
    : queue.pending

  // Over the cap the oldest goes, except `keep`, the commit of the quiz in progress: then the
  // next-oldest goes instead (SPEC 3). The cap still holds, so the new commit itself may be the one.
  let next: Queue = { ...queue, pending: [...kept, entry].sort(byCommitTime) }
  while (next.pending.length > options.cap) {
    const oldest = next.pending.find(pending => !isCommit(pending, options.keep))
    if (oldest === undefined) break
    next = expire(next, oldest, 'cap', options.now)
  }
  return next
}

const isCommit = (entry: QueueEntry, commit: CommitRef | undefined): boolean =>
  commit !== undefined && entry.repo === commit.repo && entry.hash === commit.hash

// `/quiz skip`: the commit stays pending but ranks behind the ones never skipped (see selectNext).
export const markSkipped = (queue: Queue, commit: CommitRef, now: string): Queue =>
  queue.pending.some(entry => isCommit(entry, commit))
    ? { ...queue, pending: queue.pending.map(entry => (isCommit(entry, commit) ? { ...entry, skippedAt: now } : entry)) }
    : queue

// The order /quiz tries pending commits in: the ones never skipped, newest first; then the skipped
// ones, the one skipped longest ago first (skipped at the same moment: the newest commit first).
const pickOrder = (pending: readonly QueueEntry[]): QueueEntry[] => [
  ...pending.filter(entry => entry.skippedAt === undefined).reverse(),
  ...pending
    .filter(entry => entry.skippedAt !== undefined)
    .sort((a, b) => timeOf(a.skippedAt!) - timeOf(b.skippedAt!) || byCommitTime(b, a)),
]

// The next pending commit to quiz, in pick order, that still exists. Missing ones expire on the
// way; the one returned stays pending (a skipped quiz is still there next time).
export const selectNext = async (
  queue: Queue,
  check: { run: Run; exists: Exists },
  now: string,
): Promise<{ queue: Queue; entry?: QueueEntry }> => {
  let current = queue
  for (const candidate of pickOrder(queue.pending)) {
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
  (typeof value.parent === 'string' || value.parent === null) &&
  (value.skippedAt === undefined || typeof value.skippedAt === 'string')

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

// Stored by store.ts (crash-safe load/save shared with active.json).
const QUEUE_FILE: StoreFile<Queue> = {
  name: 'queue',
  // a file from before seenAt existed loads with an empty one
  parse: value => (isQueue(value) ? { ...value, seenAt: value.seenAt ?? {} } : undefined),
}

type QueueLoad = { queue: Queue; notice?: string; isWritable: boolean }

const unreadable = (reason: string): QueueLoad => ({
  queue: emptyQueue(),
  isWritable: false,
  notice: `after-build-quiz: could not read queue.json (${reason}); using an empty queue and not overwriting it this session`,
})

// Loading to change the queue: a corrupt queue.json is copied aside, so only a data folder checked to
// be outside any repo (SafeDataDir) is accepted.
export const loadQueue = async (io: QueueIO, dataDir: SafeDataDir, now: string): Promise<QueueLoad> => {
  const loaded = await loadStore(io, dataDir, QUEUE_FILE, now)
  switch (loaded.kind) {
    case 'unreadable':
      return unreadable(loaded.reason)
    case 'found':
      return { queue: loaded.value, isWritable: true }
    case 'asideFailed':
      return {
        queue: emptyQueue(),
        isWritable: false,
        notice: 'after-build-quiz: queue.json is corrupt and could not be copied aside; not overwriting it this session',
      }
    case 'setAside':
      return {
        queue: emptyQueue(),
        isWritable: true,
        notice: `after-build-quiz: queue.json was corrupt; saved it as ${loaded.asideName} and started a fresh queue`,
      }
    case 'absent':
      return { queue: emptyQueue(), isWritable: true }
  }
}

// Reading only, for the status line: a plain path is enough, and nothing is ever written, not even
// the copy aside.
export const peekQueue = async (io: QueueIO, dataDir: string): Promise<QueueLoad> => {
  const peeked = await peekStore(io, dataDir, QUEUE_FILE)
  switch (peeked.kind) {
    case 'unreadable':
      return unreadable(peeked.reason)
    case 'found':
      return { queue: peeked.value, isWritable: true }
    case 'corrupt':
      return {
        queue: emptyQueue(),
        isWritable: false,
        notice: 'after-build-quiz: queue.json is corrupt; it will be copied aside at the next commit',
      }
    case 'absent':
      return { queue: emptyQueue(), isWritable: true }
  }
}

// Each save raises seq; the queue is written as it is, unchecked.
export const saveQueue = async (
  io: QueueIO,
  dataDir: SafeDataDir,
  queue: Queue,
): Promise<{ isSaved: boolean; queue: Queue }> => {
  const next: Queue = { ...queue, seq: queue.seq + 1 }
  return (await saveStore(io, dataDir, QUEUE_FILE, next)) ? { isSaved: true, queue: next } : { isSaved: false, queue }
}

// The status line: "N quizzes pending", or nothing when none are.
export const statusText = (queue: Queue): string | undefined => {
  const count = queue.pending.length
  if (count === 0) return undefined
  return count === 1 ? '1 quiz pending' : `${count} quizzes pending`
}
