import type { QType } from './log.ts'
import type { SafeDataDir } from './paths.ts'
import { oneLine } from './queue.ts'
import type { QueueIO } from './queue.ts'

// The quiz in progress: <dataDir>/active.json. See SPEC behaviour 4–7 and "Storage".
// Crash-safe the way queue.json is: the whole file goes to `.tmp` first, then to active.json, each save
// raises `seq`, and a load takes the valid copy with the higher seq. Writes only take a data folder
// checked to be outside any repo (SafeDataDir). Nothing here throws, and no notice ever quotes the
// file: it holds key points and answers (a JSON parse error quotes its input, so it is never passed on).

export type ActiveQuestion = {
  qtype: QType
  concept: string | null
  question: string
  keyPoints: string[] // private: shown only after an attempt, never sent to the main model
  codeRefs: string[] // `path:line` cites, each a line of the diff
}

// One answer held back: a draft the cut-off check kept, or an answer the grader never saw.
export type Held = { kind: 'draft' | 'unsent'; text: string }

export type ActiveQuiz = {
  sessionId: string // the session that started or last resumed it
  isPaused: boolean
  pausedAt: string | null
  startedAt: string
  commit: { repo: string; repoName: string; hash: string; subject: string }
  questions: ActiveQuestion[] // exactly 3: why, concept, explain
  current: number // 0–2: the question being asked
  held: Held | null
  attempt: { id: string; date: string } | null // saved before the log write (SPEC 9)
}

// `quiz: null` is a state of its own, saved with a higher seq, so an older copy can never bring a quiz back.
export type ActiveFile = { version: 1; seq: number; quiz: ActiveQuiz | null }

export type ActiveLoad = { file: ActiveFile; isWritable: boolean; notice?: string }

// What an update does to the quiz. Giving back the quiz it was handed means "no change": nothing is written.
export type Change = (quiz: ActiveQuiz | null) => ActiveQuiz | null

// `quiz` is the quiz as it now stands on disk: the changed one only if the save went through.
export type Update = { quiz: ActiveQuiz | null; isChanged: boolean; isSaved: boolean; notice?: string }

export const emptyActive = (): ActiveFile => ({ version: 1, seq: 0, quiz: null })

const QTYPES: readonly unknown[] = ['why', 'concept', 'explain']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown): value is string => typeof value === 'string'

const isTexts = (value: unknown): boolean => Array.isArray(value) && value.every(isText)

const isQuestion = (value: unknown): boolean =>
  isRecord(value) &&
  QTYPES.includes(value.qtype) &&
  (isText(value.concept) || value.concept === null) &&
  isText(value.question) && isTexts(value.keyPoints) && isTexts(value.codeRefs)

const isQuiz = (value: unknown): boolean =>
  isRecord(value) &&
  isText(value.sessionId) &&
  typeof value.isPaused === 'boolean' &&
  (isText(value.pausedAt) || value.pausedAt === null) &&
  isText(value.startedAt) &&
  isRecord(value.commit) &&
  isText(value.commit.repo) && isText(value.commit.repoName) && isText(value.commit.hash) && isText(value.commit.subject) &&
  Array.isArray(value.questions) && value.questions.length === 3 && value.questions.every(isQuestion) &&
  Number.isInteger(value.current) && (value.current as number) >= 0 && (value.current as number) <= 2 &&
  (value.held === null ||
    (isRecord(value.held) && (value.held.kind === 'draft' || value.held.kind === 'unsent') && isText(value.held.text))) &&
  (value.attempt === null || (isRecord(value.attempt) && isText(value.attempt.id) && isText(value.attempt.date)))

const isFile = (value: unknown): value is ActiveFile =>
  isRecord(value) &&
  value.version === 1 &&
  Number.isInteger(value.seq) && (value.seq as number) >= 0 &&
  (value.quiz === null || isQuiz(value.quiz))

type FileState =
  | { state: 'absent' }
  | { state: 'unreadable'; reason: string }
  | { state: 'invalid'; text: string }
  | { state: 'valid'; file: ActiveFile }

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
    return isFile(value) ? { state: 'valid', file: value } : { state: 'invalid', text }
  } catch {
    return { state: 'invalid', text } // the parse error quotes the file: dropped, never reported
  }
}

const filesOf = (dataDir: string) => ({ main: `${dataDir}/active.json`, tmp: `${dataDir}/active.json.tmp` })

// Both copies as they stand: active.json, and the newer of the valid ones (a tie keeps active.json).
const readCopies = async (io: QueueIO, dataDir: string) => {
  const { main, tmp } = filesOf(dataDir)
  const mainState = await readState(io, main)
  const tmpState = await readState(io, tmp)
  const valid = [mainState, tmpState].flatMap(copy => (copy.state === 'valid' ? [copy.file] : []))
  const newest = valid.length === 0 ? undefined : valid.reduce((best, file) => (file.seq > best.seq ? file : best))
  return { mainState, newest }
}

const unreadableNotice = (reason: string) =>
  `after-build-quiz: could not read active.json (${reason}); not using or overwriting it this session`

// Reading only, for the status line: a plain path is enough, and nothing is ever written,
// not even the copy aside.
export const peekActive = async (
  io: QueueIO, dataDir: string,
): Promise<{ quiz: ActiveQuiz | null; notice?: string }> => {
  try {
    const { mainState, newest } = await readCopies(io, dataDir)
    if (mainState.state === 'unreadable') return { quiz: null, notice: unreadableNotice(mainState.reason) }
    if (newest !== undefined) return { quiz: newest.quiz }
    if (mainState.state === 'invalid') {
      return { quiz: null, notice: 'after-build-quiz: active.json is corrupt; it will be copied aside at the next /quiz' }
    }
    return { quiz: null }
  } catch {
    return { quiz: null }
  }
}

// An unreadable active.json is never used or overwritten, whatever the `.tmp` copy holds. A corrupt one
// with no good copy is copied aside and the quiz is gone; its commit is still in the queue.
export const loadActive = async (io: QueueIO, dataDir: SafeDataDir, now: string): Promise<ActiveLoad> => {
  try {
    const { mainState, newest } = await readCopies(io, dataDir)
    if (mainState.state === 'unreadable') {
      return { file: emptyActive(), isWritable: false, notice: unreadableNotice(mainState.reason) }
    }
    if (newest !== undefined) return { file: newest, isWritable: true }

    if (mainState.state === 'invalid') {
      const asideName = `active.corrupt-${now.replace(/[:.]/g, '-')}.json`
      try {
        await io.write(`${dataDir}/${asideName}`, mainState.text)
      } catch {
        return {
          file: emptyActive(),
          isWritable: false,
          notice: 'after-build-quiz: active.json is corrupt and could not be copied aside; not overwriting it this session',
        }
      }
      return {
        file: emptyActive(),
        isWritable: true,
        notice: `after-build-quiz: active.json was corrupt; saved it as ${asideName}. The quiz in progress is lost; its commit is still pending`,
      }
    }

    return { file: emptyActive(), isWritable: true }
  } catch {
    return { file: emptyActive(), isWritable: false }
  }
}

// `.tmp` first, then active.json, so at every moment one of them is whole. A file that would not load
// back is never written.
export const saveActive = async (
  io: QueueIO, dataDir: SafeDataDir, file: ActiveFile,
): Promise<{ isSaved: boolean; file: ActiveFile }> => {
  const { main, tmp } = filesOf(dataDir)
  const next: ActiveFile = { version: 1, seq: file.seq + 1, quiz: file.quiz }
  try {
    if (!isFile(next)) return { isSaved: false, file }
    const text = `${JSON.stringify(next, null, 2)}\n`
    await io.write(tmp, text)
    await io.write(main, text)
    return { isSaved: true, file: next }
  } catch {
    return { isSaved: false, file }
  }
}

const updateNow = async (io: QueueIO, dataDir: SafeDataDir, now: string, change: Change): Promise<Update> => {
  const loaded = await loadActive(io, dataDir, now)
  const before = loaded.file.quiz
  const told = (update: Update): Update => (loaded.notice === undefined ? update : { ...update, notice: loaded.notice })
  if (!loaded.isWritable) return told({ quiz: before, isChanged: false, isSaved: false })

  let after: ActiveQuiz | null
  try {
    after = change(before)
  } catch {
    return told({ quiz: before, isChanged: false, isSaved: false })
  }
  if (after === before) return told({ quiz: before, isChanged: false, isSaved: false })

  const saved = await saveActive(io, dataDir, { ...loaded.file, quiz: after })
  return told({ quiz: saved.isSaved ? after : before, isChanged: true, isSaved: saved.isSaved })
}

// One update at a time in this process: each loads what the one before it saved, so a pause that
// arrives while a grade is being written is applied on top of it, not lost. Sessions in other
// processes can still race (SPEC Storage: accepted for v1).
let chain: Promise<unknown> = Promise.resolve()

export const updateActive = (io: QueueIO, dataDir: SafeDataDir, now: string, change: Change): Promise<Update> => {
  const run = chain.then(() => updateNow(io, dataDir, now, change))
  chain = run.catch(() => undefined)
  return run.catch((): Update => ({ quiz: null, isChanged: false, isSaved: false }))
}
