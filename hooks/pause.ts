import type { ActiveQuiz, Change } from './active.ts'
import { statusText } from './queue.ts'
import type { Queue } from './queue.ts'

// Pause and resume: pure decisions over the quiz in active.json. See SPEC behaviour 7.
// Pausing only sets a flag: there is no tool guard, and nothing here blocks, delays or rewrites anything.

// What prompt.submit hands a hook, as far as pausing reads it. The text is only tested for `/quiz`.
export type PromptLike = {
  text: string
  origin: { kind: string }
  isMeta?: true
  command?: { name: string; args: string }
}

// How this session sees the quiz: none, its own and running, or paused (flagged, or another session's).
export type QuizView = 'none' | 'live' | 'paused'

// The person at the prompt: typed, Remote Control, the SDK host's own turn, their own Slack ping.
// Every other origin (plugins, peers, notifications, schedules, channels, unclassified) never pauses.
export const PERSON_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk', 'slack-ping']

// Built-ins that start no model turn. On Claude Code 2.1.325 they raise no prompt event at all; listed
// so they still do not pause if a later version raises one.
export const NO_TURN_COMMANDS: readonly string[] = ['help', 'status', 'cost', 'compact']

const QUIZ_COMMANDS: readonly string[] = ['quiz', 'after-build-quiz:quiz']
const QUIZ_TEXT = /^\s*\/(?:after-build-quiz:)?quiz(?:\s|$)/

// `/quiz …` itself. It raises no prompt event today; the text test is a guard in case it ever does.
export const isQuizCommand = (e: PromptLike): boolean =>
  e.command === undefined ? QUIZ_TEXT.test(e.text) : QUIZ_COMMANDS.includes(e.command.name)

export const isPausingPrompt = (e: PromptLike): boolean =>
  PERSON_ORIGINS.includes(e.origin.kind) &&
  e.isMeta !== true &&
  !isQuizCommand(e) &&
  !(e.command !== undefined && NO_TURN_COMMANDS.includes(e.command.name))

export const viewOf = (quiz: ActiveQuiz | null, sessionId: string): QuizView => {
  if (quiz === null) return 'none'
  return quiz.isPaused || quiz.sessionId !== sessionId ? 'paused' : 'live'
}

// Only the flag and the time change; a held draft or unsent answer stays as it is.
export const pause = (quiz: ActiveQuiz, now: string): ActiveQuiz =>
  quiz.isPaused ? quiz : { ...quiz, isPaused: true, pausedAt: now }

// The change a pausing prompt or a session end applies: this session's running quiz is paused;
// no quiz, a paused one, or another session's is given back untouched (so nothing is written).
export const pauseIfLive = (sessionId: string, now: string): Change => quiz =>
  quiz !== null && viewOf(quiz, sessionId) === 'live' ? pause(quiz, now) : quiz

// The resuming session takes the quiz over.
export const resume = (quiz: ActiveQuiz, sessionId: string): ActiveQuiz =>
  !quiz.isPaused && quiz.sessionId === sessionId ? quiz : { ...quiz, sessionId, isPaused: false, pausedAt: null }

// Which `/quiz` arguments resume a paused quiz: none, `send` and an answer do; `skip` ends it and
// `stats` (and `calibrate` with devMode on) leave it paused. A subcommand is one only when it is the
// whole argument (SPEC 4).
export const resumesQuiz = (args: string, devMode: boolean): boolean => {
  const word = args.trim()
  return !(word === 'skip' || word === 'stats' || (devMode && word === 'calibrate'))
}

export const PAUSED_STATUS = 'quiz paused · /quiz to resume'

// The status line: the paused note (with the count when more than one commit is pending), else the
// pending count as before.
export const statusLine = (queue: Queue, view: QuizView): string | undefined => {
  if (view !== 'paused') return statusText(queue)
  const count = queue.pending.length
  return count > 1 ? `${PAUSED_STATUS} · ${count} pending` : PAUSED_STATUS
}
