// Test helper (not a test file): a synthetic quiz in progress. Every string a quiz must keep private
// (questions, key points, a held answer) starts with CANARY, so a leak test can search for that word.
import type { ActiveQuiz } from '../hooks/active.ts'
import { DATA, SESSION } from './world.ts'

export const ACTIVE = `${DATA}/active.json`
export const ACTIVE_TMP = `${ACTIVE}.tmp`
export const CANARY = 'CANARY'
export const HASH = 'c'.repeat(40)

export const quizOf = (overrides: Partial<ActiveQuiz> = {}): ActiveQuiz => ({
  sessionId: SESSION,
  isPaused: false,
  pausedAt: null,
  startedAt: '2026-10-10T08:00:00.000Z',
  commit: { repo: 'C:/work/foo', repoName: 'foo', hash: HASH, subject: 'Add retry to the uploader' },
  questions: [
    {
      qtype: 'why', concept: 'idempotency', question: 'CANARY-Q1 Why does the retry reuse the request id?',
      keyPoints: ['CANARY-KP1 a retried write must not apply twice'], codeRefs: ['src/upload.ts:12'],
    },
    {
      qtype: 'concept', concept: 'backoff', question: 'CANARY-Q2 What does the growing delay protect?',
      keyPoints: ['CANARY-KP2 the server under load', 'CANARY-KP3 jitter spreads the retries'], codeRefs: ['src/upload.ts:20'],
    },
    {
      qtype: 'explain', concept: 'retries', question: 'CANARY-Q3 Explain this commit to an interviewer.',
      keyPoints: ['CANARY-KP4 failed uploads are retried safely'], codeRefs: ['src/upload.ts:8'],
    },
  ],
  current: 1,
  held: null,
  attempt: null,
  ...overrides,
})

export const DRAFT = { kind: 'draft', text: 'CANARY-DRAFT it backs off because' } as const
export const UNSENT = { kind: 'unsent', text: 'CANARY-UNSENT the delay doubles so the server can recover.' } as const

// the file as saveActive writes it
export const fileText = (quiz: ActiveQuiz | null, seq = 1): string =>
  `${JSON.stringify({ version: 1, seq, quiz }, null, 2)}\n`
