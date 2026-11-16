import { describe, expect, test } from 'claude-code/testing'
import type { PromptOrigin } from 'claude-code'

import {
  isPausingPrompt, isQuizCommand, NO_TURN_COMMANDS, pause, pauseIfLive, PERSON_ORIGINS, resume, resumesQuiz,
  statusLine, viewOf,
} from '../hooks/pause.ts'
import type { PromptLike } from '../hooks/pause.ts'
import { emptyQueue } from '../hooks/queue.ts'
import { DRAFT, quizOf, UNSENT } from './quiz-fixture.ts'
import { pendingEntry, SESSION } from './world.ts'

const NOW = '2026-11-16T10:00:00.000Z'
const LATER = '2026-11-16T11:00:00.000Z'

const typed = (text: string, origin: PromptOrigin = { kind: 'composer' }): PromptLike => ({ text, origin })

// SPEC 7: typed, Remote Control, SDK, and the owner's own Slack ping.
const PERSON: PromptOrigin[] = [{ kind: 'composer' }, { kind: 'bridge' }, { kind: 'sdk' }, { kind: 'slack-ping' }]

// Every other origin the engine names (2.1.325): none of them is the person at the prompt.
const NOT_PERSON: PromptOrigin[] = [
  { kind: 'task-notification' }, { kind: 'scheduled-trigger' }, { kind: 'peer' }, { kind: 'peer-send-message' },
  { kind: 'projects-relay' }, { kind: 'channel', server: 'slack' }, { kind: 'coordinator' }, { kind: 'observer' },
  { kind: 'observer-activity' }, { kind: 'auto-continuation' }, { kind: 'unclassified' },
  { kind: 'plugin', name: 'other-plugin' }, { kind: 'plugin', name: 'other-plugin', asUser: true },
]

// What the engine raised for each input on Claude Code 2.1.325 (interactive probe, 2026-11-16).
// Only a raised prompt.submit can pause. The commands that start no model turn raised none; they are
// also listed in NO_TURN_COMMANDS so they still would not pause if a later version raised one.
// `!` is not a command: it raises nothing and cannot be seen at all (SPEC Known limits).
const PROBE_2_1_325 = [
  { input: 'a typed prompt', raisesPromptSubmit: true, command: undefined },
  { input: '/help', raisesPromptSubmit: false, command: 'help' },
  { input: '/status', raisesPromptSubmit: false, command: 'status' },
  { input: '/cost', raisesPromptSubmit: false, command: 'cost' },
  { input: '/compact', raisesPromptSubmit: false, command: 'compact' },
  { input: '! echo probe', raisesPromptSubmit: false, command: undefined },
] as const

describe('isPausingPrompt: which prompts pause a quiz', () => {
  test('the agreed person origins, and only those, are listed', () => {
    expect([...PERSON_ORIGINS].sort()).toEqual(['bridge', 'composer', 'sdk', 'slack-ping'])
  })

  for (const origin of PERSON) {
    test(`a prompt from the person pauses: ${origin.kind}`, () => {
      expect(isPausingPrompt(typed('fix the login bug', origin))).toBe(true)
    })
  }

  for (const origin of NOT_PERSON) {
    const label = origin.kind === 'plugin' && origin.asUser === true ? 'plugin (asUser)' : origin.kind
    test(`a prompt that is not the person's does not pause: ${label}`, () => {
      expect(isPausingPrompt(typed('fix the login bug', origin))).toBe(false)
    })
  }

  test('an origin kind this version does not know does not pause', () => {
    expect(isPausingPrompt({ text: 'hello', origin: { kind: 'something-new' } })).toBe(false)
  })

  test('a prompt the person does not see as typed (isMeta) does not pause', () => {
    expect(isPausingPrompt({ ...typed('continue'), isMeta: true })).toBe(false)
  })

  for (const text of ['/quiz', '/quiz my answer', '  /quiz skip', '/quiz\nsecond line', '/quiz\tsend', '/after-build-quiz:quiz stats']) {
    test(`/quiz typed as text does not pause: ${JSON.stringify(text)}`, () => {
      expect(isQuizCommand(typed(text))).toBe(true)
      expect(isPausingPrompt(typed(text))).toBe(false)
    })
  }

  for (const name of ['quiz', 'after-build-quiz:quiz']) {
    test(`the ${name} command does not pause, whatever its masked text is`, () => {
      const e: PromptLike = { ...typed(''), command: { name, args: '' } }
      expect(isQuizCommand(e)).toBe(true)
      expect(isPausingPrompt(e)).toBe(false)
    })
  }

  for (const text of ['/quizzes', '/quizx answer', 'quiz me on this', 'run /quiz later', '/ quiz', '/Quiz']) {
    test(`text that only looks like /quiz pauses: ${JSON.stringify(text)}`, () => {
      expect(isQuizCommand(typed(text))).toBe(false)
      expect(isPausingPrompt(typed(text))).toBe(true)
    })
  }

  test('another command that starts a model turn (a skill) pauses', () => {
    expect(isPausingPrompt({ ...typed('/simplify'), command: { name: 'simplify', args: '' } })).toBe(true)
  })

  test('a command named quiz-something is not /quiz', () => {
    expect(isPausingPrompt({ ...typed('/quiz-report'), command: { name: 'quiz-report', args: '' } })).toBe(true)
  })

  test('the probe table: the commands that raised no prompt event are the no-turn list', () => {
    const noTurn = PROBE_2_1_325.flatMap(row => (!row.raisesPromptSubmit && row.command !== undefined ? [row.command] : []))
    expect([...NO_TURN_COMMANDS].sort()).toEqual([...noTurn].sort())
  })

  for (const row of PROBE_2_1_325) {
    if (row.command === undefined || row.raisesPromptSubmit) continue
    test(`a built-in that starts no model turn would not pause even if a prompt event were raised: ${row.input}`, () => {
      expect(isPausingPrompt({ ...typed(row.input), command: { name: row.command, args: '' } })).toBe(false)
    })
  }
})

describe('pause and resume: only the flag changes', () => {
  test('pause sets the flag and the time and nothing else; the quiz it was given is not changed', () => {
    const quiz = quizOf()
    const before = JSON.stringify(quiz)

    const paused = pause(quiz, NOW)

    expect(paused).toEqual({ ...quiz, isPaused: true, pausedAt: NOW })
    expect(JSON.stringify(quiz)).toBe(before)
  })

  test('pause mid-draft: the held draft is kept exactly', () => {
    const paused = pause(quizOf({ held: DRAFT }), NOW)
    expect(paused.isPaused).toBe(true)
    expect(paused.held).toEqual(DRAFT)
    expect(paused.current).toBe(1)
  })

  test('pause after an answer the grader never saw: the unsent answer and its attempt id are kept', () => {
    const attempt = { id: 'attempt-7', date: '2026-11-16T09:59:00.000Z' }
    const paused = pause(quizOf({ held: UNSENT, attempt }), NOW)
    expect(paused.isPaused).toBe(true)
    expect(paused.held).toEqual(UNSENT)
    expect(paused.attempt).toEqual(attempt)
  })

  test('pausing a paused quiz gives the same quiz back (no write follows, the first time is kept)', () => {
    const paused = pause(quizOf(), NOW)
    expect(pause(paused, LATER)).toBe(paused)
  })

  test('resume clears the flag and the time, takes over the session, and keeps the rest', () => {
    const paused = quizOf({ isPaused: true, pausedAt: NOW, held: DRAFT, sessionId: 'an-older-session' })
    expect(resume(paused, SESSION)).toEqual(quizOf({ held: DRAFT }))
  })

  test('resume keeps an unsent answer for the resend', () => {
    const paused = quizOf({ isPaused: true, pausedAt: NOW, held: UNSENT })
    expect(resume(paused, SESSION).held).toEqual(UNSENT)
  })

  test("resuming this session's running quiz gives the same quiz back", () => {
    const live = quizOf()
    expect(resume(live, SESSION)).toBe(live)
  })

  test("another session's unpaused quiz is taken over on resume", () => {
    const theirs = quizOf({ sessionId: 'another-session' })
    expect(resume(theirs, SESSION)).toEqual(quizOf())
  })
})

describe('viewOf: how this session sees the quiz', () => {
  test('no quiz', () => { expect(viewOf(null, SESSION)).toBe('none') })
  test('its own, not paused: live', () => { expect(viewOf(quizOf(), SESSION)).toBe('live') })
  test('its own, paused', () => { expect(viewOf(quizOf({ isPaused: true, pausedAt: NOW }), SESSION)).toBe('paused') })
  test('left unpaused by another session: paused', () => {
    expect(viewOf(quizOf({ sessionId: 'another-session' }), SESSION)).toBe('paused')
  })
})

describe('pauseIfLive: the change a pausing prompt or a session end applies', () => {
  test("this session's running quiz is paused", () => {
    expect(pauseIfLive(SESSION, NOW)(quizOf())).toEqual(quizOf({ isPaused: true, pausedAt: NOW }))
  })

  test('no quiz: nothing to change', () => {
    expect(pauseIfLive(SESSION, NOW)(null)).toBe(null)
  })

  test('an already paused quiz is given back as it is', () => {
    const paused = quizOf({ isPaused: true, pausedAt: NOW })
    expect(pauseIfLive(SESSION, LATER)(paused)).toBe(paused)
  })

  test("another session's quiz is never written by this one", () => {
    const theirs = quizOf({ sessionId: 'another-session' })
    expect(pauseIfLive(SESSION, NOW)(theirs)).toBe(theirs)
  })
})

describe('resumesQuiz: which /quiz arguments resume a paused quiz', () => {
  for (const [args, expected] of [
    ['', true], ['   ', true], ['send', true], ['the delay doubles.', true],
    ['skip', false], ['stats', false], [' skip ', false],
    ['skip it for now', true], ['stats are averaged', true], ['calibrate', true],
  ] as const) {
    test(`${JSON.stringify(args)} → ${expected ? 'resumes' : 'does not resume'}`, () => {
      expect(resumesQuiz(args, false)).toBe(expected)
    })
  }

  test('calibrate is a subcommand only with devMode on: then it does not resume', () => {
    expect(resumesQuiz('calibrate', true)).toBe(false)
    expect(resumesQuiz('calibrate the grader', true)).toBe(true)
  })
})

describe('statusLine', () => {
  const queueOf = (count: number) => ({
    ...emptyQueue(),
    pending: Array.from({ length: count }, (_, index) => pendingEntry(String(index).repeat(40))),
  })

  test('paused: the resume hint; the pending count only when more than one is pending', () => {
    expect(statusLine(queueOf(0), 'paused')).toBe('quiz paused · /quiz to resume')
    expect(statusLine(queueOf(1), 'paused')).toBe('quiz paused · /quiz to resume')
    expect(statusLine(queueOf(2), 'paused')).toBe('quiz paused · /quiz to resume · 2 pending')
    expect(statusLine(queueOf(7), 'paused')).toBe('quiz paused · /quiz to resume · 7 pending')
  })

  test('a running quiz, or none: the pending count as before', () => {
    for (const view of ['live', 'none'] as const) {
      expect(statusLine(queueOf(0), view)).toBe(undefined)
      expect(statusLine(queueOf(1), view)).toBe('1 quiz pending')
      expect(statusLine(queueOf(3), view)).toBe('3 quizzes pending')
    }
  })
})
