import { redactLines } from './context.ts'
import type { SafeDataDir } from './paths.ts'
import { oneLine } from './queue.ts'
import type { QueueIO } from './queue.ts'

// The weak-spot log: one line per attempt in <dataDir>/log/YYYY-MM.jsonl. See SPEC behaviour 9.
// $.fs has no append or rename, so an append rewrites the month file: to `.tmp` first, then to the file.
// The file only grows, so of the two copies the one with more valid lines is the newer. Only a data
// folder checked to be outside any repo (SafeDataDir) is accepted. Nothing here throws.

export type QType = 'why' | 'concept' | 'explain'

export type Attempt = {
  id: string // made by the quiz step and saved with `date` in active.json before the log write
  date: string
  repo: string
  repoName: string
  commit: string
  subject: string
  qtype: QType
  concept: string | null
  question: string
  answer: string
  score: 0 | 1 | 2 | null // null: ungraded
  gap: string | null
  codeRefs: string[]
}

export type LogEntry = { v: 1 } & Attempt

export type LogIO = QueueIO & { list: (path: string) => Promise<string[]> } // list: names in a folder

export type AppendResult = { isLogged: boolean; isDuplicate?: boolean; notice?: string }

export type LogRead = { entries: LogEntry[]; skipped: number; unreadable: string[] }

export const LOG_LIMITS = { answer: 8_000, question: 2_000, gap: 2_000, monthBytes: 3.5 * 1024 * 1024 }

const QTYPES: readonly unknown[] = ['why', 'concept', 'explain']
const SCORES: readonly unknown[] = [0, 1, 2, null]
const MONTH_FILE = /^(\d{4}-\d{2})\.jsonl(?:\.tmp)?$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isEntry = (value: unknown): value is LogEntry =>
  isRecord(value) &&
  value.v === 1 &&
  typeof value.id === 'string' && value.id !== '' &&
  typeof value.date === 'string' && !Number.isNaN(Date.parse(value.date)) &&
  typeof value.repo === 'string' && typeof value.repoName === 'string' && typeof value.commit === 'string' &&
  typeof value.subject === 'string' &&
  QTYPES.includes(value.qtype) &&
  (typeof value.concept === 'string' || value.concept === null) &&
  typeof value.question === 'string' && typeof value.answer === 'string' &&
  SCORES.includes(value.score) &&
  (typeof value.gap === 'string' || value.gap === null) &&
  Array.isArray(value.codeRefs) && value.codeRefs.every(ref => typeof ref === 'string')

const capped = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)} [… ${text.length - limit} characters cut]`

const redacted = (text: string, limit?: number) => {
  const clean = redactLines(text).text
  return limit === undefined ? clean : capped(clean, limit)
}

// The line as written: v first, the SPEC fields in order, date in UTC, secrets redacted, long fields cut.
const entryOf = (attempt: Attempt): LogEntry | undefined => {
  const time = Date.parse(attempt.date)
  if (Number.isNaN(time)) return undefined
  const entry: LogEntry = {
    v: 1,
    id: attempt.id,
    date: new Date(time).toISOString(),
    repo: attempt.repo,
    repoName: attempt.repoName,
    commit: attempt.commit,
    subject: redacted(attempt.subject),
    qtype: attempt.qtype,
    concept: attempt.concept,
    question: redacted(attempt.question, LOG_LIMITS.question),
    answer: redacted(attempt.answer, LOG_LIMITS.answer),
    score: attempt.score,
    gap: attempt.gap === null ? null : redacted(attempt.gap, LOG_LIMITS.gap),
    codeRefs: [...attempt.codeRefs],
  }
  return isEntry(entry) && /^\d{4}-\d{2}-/.test(entry.date) ? entry : undefined
}

const utf8Bytes = (text: string) => {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

// A copy as read: its valid lines verbatim, their entries, and how many lines were damaged.
type Copy = { lines: string[]; entries: LogEntry[]; damaged: number; text: string }
type CopyState = { state: 'absent' } | { state: 'unreadable'; reason: string } | ({ state: 'read' } & Copy)

const parse = (text: string): Copy => {
  const copy: Copy = { lines: [], entries: [], damaged: 0, text }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (isEntry(value)) {
        copy.lines.push(line)
        copy.entries.push(value)
        continue
      }
    } catch {}
    copy.damaged++ // includes a last line cut off mid-write
  }
  return copy
}

const readCopy = async (io: LogIO, path: string): Promise<CopyState> => {
  try {
    if (!(await io.exists(path))) return { state: 'absent' }
    return { state: 'read', ...parse(await io.read(path)) }
  } catch (error) {
    return { state: 'unreadable', reason: oneLine(String(error)) }
  }
}

const EMPTY: Copy = { lines: [], entries: [], damaged: 0, text: '' }

// The month as it stands: the copy with more valid lines (a tie keeps the month file); an unreadable
// month file stops everything, an unreadable `.tmp` is ignored.
const loadMonth = async (io: LogIO, dataDir: SafeDataDir, month: string) => {
  const main = await readCopy(io, `${dataDir}/log/${month}.jsonl`)
  if (main.state === 'unreadable') return { isReadable: false as const, reason: main.reason }
  const tmp = await readCopy(io, `${dataDir}/log/${month}.jsonl.tmp`)
  const mainCopy = main.state === 'read' ? main : EMPTY
  const winner = tmp.state === 'read' && tmp.entries.length > mainCopy.entries.length ? tmp : mainCopy
  return { isReadable: true as const, copy: winner }
}

const appendNow = async (
  io: LogIO, dataDir: SafeDataDir, attempt: Attempt, options: { now: string },
): Promise<AppendResult> => {
  const entry = entryOf(attempt)
  if (entry === undefined) return { isLogged: false }
  const month = entry.date.slice(0, 7)
  const name = `log/${month}.jsonl`
  try {
    const loaded = await loadMonth(io, dataDir, month)
    if (!loaded.isReadable) {
      return {
        isLogged: false,
        notice: `after-build-quiz: could not read ${name} (${loaded.reason}); this answer was not logged and the file was left as it is`,
      }
    }
    const { copy } = loaded
    if (copy.entries.some(logged => logged.id === entry.id)) return { isLogged: true, isDuplicate: true }

    const text = [...copy.lines, JSON.stringify(entry)].join('\n') + '\n'
    if (utf8Bytes(text) > LOG_LIMITS.monthBytes) {
      return { isLogged: false, notice: `after-build-quiz: ${name} has reached its size limit (3.5 MiB); this answer was not logged` }
    }

    let notice: string | undefined
    if (copy.damaged > 0) {
      const aside = `log/${month}.corrupt-${options.now.replace(/[:.]/g, '-')}.jsonl`
      try {
        await io.write(`${dataDir}/${aside}`, copy.text)
      } catch {
        return { isLogged: false, notice: `after-build-quiz: ${name} is damaged and could not be copied aside; this answer was not logged` }
      }
      const lines = copy.damaged === 1 ? '1 damaged line' : `${copy.damaged} damaged lines`
      notice = `after-build-quiz: ${name} had ${lines}; saved it as ${aside} and kept the valid lines`
    }

    try {
      await io.write(`${dataDir}/${name}.tmp`, text)
      await io.write(`${dataDir}/${name}`, text)
    } catch (error) {
      return { isLogged: false, notice: `after-build-quiz: could not write ${name} (${oneLine(String(error))}); this answer was not logged` }
    }
    return notice === undefined ? { isLogged: true } : { isLogged: true, notice }
  } catch {
    return { isLogged: false }
  }
}

// One append at a time in this process, so each reads the file the one before it wrote. Sessions in other
// processes can still race (SPEC Storage: accepted for v1).
let chain: Promise<unknown> = Promise.resolve()

export const appendAttempt = (
  io: LogIO, dataDir: SafeDataDir, attempt: Attempt, options: { now: string },
): Promise<AppendResult> => {
  const run = chain.then(() => appendNow(io, dataDir, attempt, options))
  chain = run.catch(() => undefined)
  return run
}

// Every month's valid entries, oldest first; `.tmp`-only months count, corrupt copies and other files do not.
export const readLog = async (io: LogIO, dataDir: SafeDataDir): Promise<LogRead> => {
  const read: LogRead = { entries: [], skipped: 0, unreadable: [] }
  let names: string[]
  try {
    names = await io.list(`${dataDir}/log`)
  } catch {
    return read
  }
  const months = [...new Set(names.flatMap(name => MONTH_FILE.exec(name)?.[1] ?? []))].sort()
  for (const month of months) {
    const loaded = await loadMonth(io, dataDir, month)
    if (!loaded.isReadable) {
      read.unreadable.push(`log/${month}.jsonl`)
      continue
    }
    read.entries.push(...loaded.copy.entries)
    read.skipped += loaded.copy.damaged
  }
  read.entries.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return read
}
