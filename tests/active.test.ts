import { describe, expect, test } from 'claude-code/testing'

import { loadActive, peekActive, saveActive, updateActive } from '../hooks/active.ts'
import type { ActiveFile, ActiveQuiz } from '../hooks/active.ts'
import { safeDataDirOf } from '../hooks/paths.ts'
import type { QueueIO } from '../hooks/queue.ts'
import { memoryFs } from './fake-git.ts'
import { ACTIVE, ACTIVE_TMP, CANARY, DRAFT, fileText, quizOf } from './quiz-fixture.ts'
import { DATA } from './world.ts'

const DIR = safeDataDirOf(DATA, { isSafe: true })
const NOW = '2026-11-16T10:00:00.000Z'
const ASIDE = `${DATA}/active.corrupt-2026-11-16T10-00-00-000Z.json`

const fileOf = (quiz: ActiveQuiz | null, seq = 1): ActiveFile => ({ version: 1, seq, quiz })

// an fs whose writes fail from the nth one on (1 = every write)
const failingWrites = (io: QueueIO, failFrom = 1): QueueIO => {
  let count = 0
  return { ...io, write: async (path, text) => { if (++count >= failFrom) throw new Error('ENOSPC'); await io.write(path, text) } }
}

const brokenIo: QueueIO = {
  read: async () => { throw new Error('EIO') },
  write: async () => { throw new Error('EIO') },
  exists: async () => { throw new Error('EIO') },
}

describe('active.json: save and load', () => {
  test('a saved quiz loads back whole; seq goes up; .tmp is written before active.json', async () => {
    const fs = memoryFs()
    const quiz = quizOf({ held: DRAFT })

    const saved = await saveActive(fs.io, DIR, fileOf(quiz, 4))

    expect(saved.isSaved).toBe(true)
    expect(saved.file.seq).toBe(5)
    expect(fs.writes).toEqual([ACTIVE_TMP, ACTIVE])
    expect(fs.store.get(ACTIVE)).toBe(fileText(quiz, 5))
    expect(fs.store.get(ACTIVE_TMP)).toBe(fileText(quiz, 5))
    const loaded = await loadActive(fs.io, DIR, NOW)
    expect(loaded).toEqual({ file: fileOf(quiz, 5), isWritable: true })
  })

  test('no file yet: no quiz, writable, no notice, nothing written', async () => {
    const fs = memoryFs()
    expect(await loadActive(fs.io, DIR, NOW)).toEqual({ file: fileOf(null, 0), isWritable: true })
    expect(fs.writes).toEqual([])
  })

  test('a crash between the two writes: the .tmp copy with the higher seq wins', async () => {
    const paused = quizOf({ isPaused: true, pausedAt: NOW })
    const fs = memoryFs({ [ACTIVE]: fileText(quizOf(), 1), [ACTIVE_TMP]: fileText(paused, 2) })
    expect((await loadActive(fs.io, DIR, NOW)).file).toEqual(fileOf(paused, 2))
  })

  test('a crash while writing active.json (cut off mid-file): the whole .tmp copy is used, nothing copied aside', async () => {
    const fs = memoryFs({ [ACTIVE]: fileText(quizOf(), 2).slice(0, 40), [ACTIVE_TMP]: fileText(quizOf(), 2) })
    const loaded = await loadActive(fs.io, DIR, NOW)
    expect(loaded).toEqual({ file: fileOf(quizOf(), 2), isWritable: true })
    expect(fs.writes).toEqual([])
  })

  test('a cleared quiz beats an older copy that still holds one: a stale .tmp never brings a quiz back', async () => {
    const fs = memoryFs({ [ACTIVE]: fileText(null, 3), [ACTIVE_TMP]: fileText(quizOf(), 2) })
    expect((await loadActive(fs.io, DIR, NOW)).file).toEqual(fileOf(null, 3))
    expect((await peekActive(fs.io, DATA)).quiz).toBe(null)
  })

  test('a failing write: not saved, nothing thrown, the seq is not used up', async () => {
    const fs = memoryFs()
    const saved = await saveActive(failingWrites(fs.io), DIR, fileOf(quizOf(), 1))
    expect(saved).toEqual({ isSaved: false, file: fileOf(quizOf(), 1) })
  })

  test('only a checked data folder is accepted for writes (type-level: tsc checks these directives)', () => {
    const unchecked = (io: QueueIO) => {
      // @ts-expect-error a plain string is not a SafeDataDir
      void saveActive(io, 'C:/data', fileOf(null))
      // @ts-expect-error a plain string is not a SafeDataDir
      void loadActive(io, 'C:/data', NOW)
      // @ts-expect-error a plain string is not a SafeDataDir
      void updateActive(io, 'C:/data', NOW, quiz => quiz)
      void peekActive(io, 'C:/data') // reading only: a plain path is fine
    }
    expect(typeof unchecked).toBe('function')
  })
})

describe('active.json: corrupt, partial and unreadable state (as queue.json)', () => {
  test('corrupt with no good copy: copied aside, no quiz, one notice that names the copy', async () => {
    const corrupt = `{ "version": 1, "seq": 9, "quiz": { "held": "${CANARY}-DRAFT half an ans`
    const fs = memoryFs({ [ACTIVE]: corrupt })

    const loaded = await loadActive(fs.io, DIR, NOW)

    expect(loaded.file).toEqual(fileOf(null, 0))
    expect(loaded.isWritable).toBe(true)
    expect(fs.writes).toEqual([ASIDE])
    expect(fs.store.get(ASIDE)).toBe(corrupt)
    expect(loaded.notice).toBe(
      'after-build-quiz: active.json was corrupt; saved it as active.corrupt-2026-11-16T10-00-00-000Z.json. The quiz in progress is lost; its commit is still pending',
    )
  })

  const partial: [string, unknown][] = [
    ['the paused flag is missing', { ...quizOf(), isPaused: undefined }],
    ['the paused flag is not a boolean', { ...quizOf(), isPaused: 'yes' }],
    ['pausedAt is a number', { ...quizOf(), pausedAt: 5 }],
    ['the session id is missing', { ...quizOf(), sessionId: undefined }],
    ['only two questions', { ...quizOf(), questions: quizOf().questions.slice(0, 2) }],
    ['a question without key points', { ...quizOf(), questions: [{ ...quizOf().questions[0], keyPoints: undefined }, ...quizOf().questions.slice(1)] }],
    ['an unknown question type', { ...quizOf(), questions: [{ ...quizOf().questions[0], qtype: 'trivia' }, ...quizOf().questions.slice(1)] }],
    ['the current question is out of range', { ...quizOf(), current: 3 }],
    ['the current question is not a whole number', { ...quizOf(), current: 0.5 }],
    ['a held answer of an unknown kind', { ...quizOf(), held: { kind: 'other', text: 'x' } }],
    ['a held answer with no text', { ...quizOf(), held: { kind: 'draft' } }],
    ['an attempt with no date', { ...quizOf(), attempt: { id: 'a1' } }],
    ['the commit has no hash', { ...quizOf(), commit: { repo: 'C:/work/foo', repoName: 'foo', subject: 's' } }],
    ['the quiz is an array', []],
  ]
  for (const [name, quiz] of partial) {
    test(`partial state is treated as corrupt: ${name}`, async () => {
      const text = JSON.stringify({ version: 1, seq: 4, quiz })
      const fs = memoryFs({ [ACTIVE]: text })
      const loaded = await loadActive(fs.io, DIR, NOW)
      expect(loaded.file).toEqual(fileOf(null, 0))
      expect(fs.store.get(ASIDE)).toBe(text)
      expect(typeof loaded.notice).toBe('string')
    })
  }

  for (const [name, text] of [
    ['the quiz key is missing', '{"version":1,"seq":4}'],
    ['another version', JSON.stringify({ version: 2, seq: 4, quiz: null })],
    ['a negative seq', JSON.stringify({ version: 1, seq: -1, quiz: null })],
    ['not an object', '"active"'],
    ['an empty file', ''],
  ] as const) {
    test(`a damaged envelope is treated as corrupt: ${name}`, async () => {
      const fs = memoryFs({ [ACTIVE]: text })
      const loaded = await loadActive(fs.io, DIR, NOW)
      expect(loaded.file).toEqual(fileOf(null, 0))
      expect(fs.store.get(ASIDE)).toBe(text)
    })
  }

  test('corrupt active.json but a good .tmp: the .tmp copy is used, nothing is copied aside, no notice', async () => {
    const fs = memoryFs({ [ACTIVE]: '{ broken', [ACTIVE_TMP]: fileText(quizOf(), 6) })
    expect(await loadActive(fs.io, DIR, NOW)).toEqual({ file: fileOf(quizOf(), 6), isWritable: true })
    expect(fs.writes).toEqual([])
  })

  test('corrupt and the copy aside fails: not writable, the corrupt file is left as it is', async () => {
    const fs = memoryFs({ [ACTIVE]: '{ broken' })
    const loaded = await loadActive(failingWrites(fs.io), DIR, NOW)
    expect(loaded.isWritable).toBe(false)
    expect(loaded.file).toEqual(fileOf(null, 0))
    expect(loaded.notice).toBe('after-build-quiz: active.json is corrupt and could not be copied aside; not overwriting it this session')
    expect(fs.store.get(ACTIVE)).toBe('{ broken')
  })

  test('unreadable: never overwritten, no quiz, one notice; an update writes nothing', async () => {
    const fs = memoryFs({ [ACTIVE]: fileText(quizOf(), 2) })
    fs.makeUnreadable(ACTIVE)

    const loaded = await loadActive(fs.io, DIR, NOW)
    const updated = await updateActive(fs.io, DIR, NOW, () => quizOf({ current: 2 }))

    expect(loaded.isWritable).toBe(false)
    expect(loaded.file).toEqual(fileOf(null, 0))
    expect(loaded.notice).toBe('after-build-quiz: could not read active.json (Error: EIO); not using or overwriting it this session')
    expect(updated).toEqual({ quiz: null, isChanged: false, isSaved: false, notice: loaded.notice })
    expect(fs.writes).toEqual([])
  })

  test('a file system that fails every call never throws', async () => {
    expect((await loadActive(brokenIo, DIR, NOW)).isWritable).toBe(false)
    expect((await peekActive(brokenIo, DATA)).quiz).toBe(null)
    expect((await saveActive(brokenIo, DIR, fileOf(null))).isSaved).toBe(false)
    expect((await updateActive(brokenIo, DIR, NOW, () => quizOf())).isSaved).toBe(false)
  })

  test('no notice ever quotes the file: a private string in a corrupt file stays out of every notice', async () => {
    const corrupt = `${CANARY}-KP1 a retried write must not apply twice {"quiz":`
    const notices: (string | undefined)[] = []
    for (const make of [
      () => memoryFs({ [ACTIVE]: corrupt }),
      () => memoryFs({ [ACTIVE]: corrupt, [ACTIVE_TMP]: corrupt }),
    ]) {
      notices.push((await loadActive(make().io, DIR, NOW)).notice)
      notices.push((await loadActive(failingWrites(make().io), DIR, NOW)).notice)
      notices.push((await peekActive(make().io, DATA)).notice)
      notices.push((await updateActive(make().io, DIR, NOW, quiz => quiz)).notice)
    }
    expect(notices.filter(notice => notice !== undefined).length).toBe(8)
    expect(notices.join('\n')).not.toContain(CANARY)
  })
})

describe('peekActive: the status line only reads', () => {
  test('a good file: its quiz, no notice, no write', async () => {
    const fs = memoryFs({ [ACTIVE]: fileText(quizOf(), 2) })
    expect(await peekActive(fs.io, DATA)).toEqual({ quiz: quizOf() })
    expect(fs.writes).toEqual([])
  })

  test('the newer of the two copies is read', async () => {
    const paused = quizOf({ isPaused: true, pausedAt: NOW })
    const fs = memoryFs({ [ACTIVE]: fileText(quizOf(), 1), [ACTIVE_TMP]: fileText(paused, 2) })
    expect((await peekActive(fs.io, DATA)).quiz).toEqual(paused)
  })

  test('no file: no quiz, no notice', async () => {
    expect(await peekActive(memoryFs().io, DATA)).toEqual({ quiz: null })
  })

  test('corrupt: no quiz, a notice, and never a write (not even the copy aside)', async () => {
    const fs = memoryFs({ [ACTIVE]: '{ broken' })
    expect(await peekActive(fs.io, DATA)).toEqual({
      quiz: null,
      notice: 'after-build-quiz: active.json is corrupt; it will be copied aside at the next /quiz',
    })
    expect(fs.writes).toEqual([])
  })

  test('unreadable: no quiz, a notice, no write', async () => {
    const fs = memoryFs({ [ACTIVE]: fileText(quizOf(), 2) })
    fs.makeUnreadable(ACTIVE)
    expect(await peekActive(fs.io, DATA)).toEqual({
      quiz: null,
      notice: 'after-build-quiz: could not read active.json (Error: EIO); not using or overwriting it this session',
    })
    expect(fs.writes).toEqual([])
  })
})

describe('updateActive: one change at a time', () => {
  test('a change is saved with the next seq', async () => {
    const fs = memoryFs({ [ACTIVE]: fileText(quizOf(), 2) })
    const updated = await updateActive(fs.io, DIR, NOW, quiz => (quiz === null ? null : { ...quiz, current: 2 }))
    expect(updated).toEqual({ quiz: quizOf({ current: 2 }), isChanged: true, isSaved: true })
    expect(fs.store.get(ACTIVE)).toBe(fileText(quizOf({ current: 2 }), 3))
  })

  test('a change that returns the quiz it was given writes nothing', async () => {
    const fs = memoryFs({ [ACTIVE]: fileText(quizOf(), 2) })
    const updated = await updateActive(fs.io, DIR, NOW, quiz => quiz)
    expect(updated).toEqual({ quiz: quizOf(), isChanged: false, isSaved: false })
    expect(fs.writes).toEqual([])
  })

  test('clearing the quiz is saved as its own state', async () => {
    const fs = memoryFs({ [ACTIVE]: fileText(quizOf(), 2) })
    const updated = await updateActive(fs.io, DIR, NOW, () => null)
    expect(updated).toEqual({ quiz: null, isChanged: true, isSaved: true })
    expect(fs.store.get(ACTIVE)).toBe(fileText(null, 3))
    expect(fs.store.get(ACTIVE_TMP)).toBe(fileText(null, 3))
  })

  test('two updates started together are both kept: a pause queued behind a grade is not lost', async () => {
    const fs = memoryFs({ [ACTIVE]: fileText(quizOf({ current: 0 }), 1) })

    const graded = updateActive(fs.io, DIR, NOW, quiz => (quiz === null ? null : { ...quiz, current: 1 }))
    const paused = updateActive(fs.io, DIR, NOW, quiz => (quiz === null ? null : { ...quiz, isPaused: true, pausedAt: NOW }))
    await Promise.all([graded, paused])

    expect(JSON.parse(fs.store.get(ACTIVE)!)).toEqual(fileOf(quizOf({ current: 1, isPaused: true, pausedAt: NOW }), 3))
  })

  test('the other order too: a grade that lands after the pause keeps the pause', async () => {
    const fs = memoryFs({ [ACTIVE]: fileText(quizOf({ current: 0 }), 1) })

    const paused = updateActive(fs.io, DIR, NOW, quiz => (quiz === null ? null : { ...quiz, isPaused: true, pausedAt: NOW }))
    const graded = updateActive(fs.io, DIR, NOW, quiz => (quiz === null ? null : { ...quiz, current: 1 }))
    await Promise.all([paused, graded])

    expect(JSON.parse(fs.store.get(ACTIVE)!)).toEqual(fileOf(quizOf({ current: 1, isPaused: true, pausedAt: NOW }), 3))
  })

  test('a change that throws: nothing written, nothing thrown, the next update still runs', async () => {
    const fs = memoryFs({ [ACTIVE]: fileText(quizOf(), 2) })
    const failed = await updateActive(fs.io, DIR, NOW, () => { throw new Error('boom') })
    const next = await updateActive(fs.io, DIR, NOW, () => null)
    expect(failed).toEqual({ quiz: quizOf(), isChanged: false, isSaved: false })
    expect(next.isSaved).toBe(true)
  })

  test('a failed save reports the quiz as it still is on disk', async () => {
    const fs = memoryFs({ [ACTIVE]: fileText(quizOf(), 2) })
    const updated = await updateActive(failingWrites(fs.io), DIR, NOW, () => null)
    expect(updated).toEqual({ quiz: quizOf(), isChanged: true, isSaved: false })
    expect(fs.store.get(ACTIVE)).toBe(fileText(quizOf(), 2))
  })

  test('every write lands in the data folder, on active.json, its .tmp or a corrupt copy', async () => {
    const fs = memoryFs({ [ACTIVE]: '{ broken' })
    await updateActive(fs.io, DIR, NOW, () => quizOf())
    expect(fs.writes).toEqual([ASIDE, ACTIVE_TMP, ACTIVE])
  })
})
