import { describe, expect, test } from 'claude-code/testing'
import type { ModelCompleteRequest, ModelCompleteResult } from 'claude-code'

import { CALIBRATION_RUNS, hardFailures, runCalibration } from '../hooks/calibrate.ts'
import type { CalibrationRow, CaseLabel } from '../hooks/calibrate.ts'
import { isSecretLine } from '../hooks/context.ts'
import { safeDataDirOf } from '../hooks/paths.ts'
import type { QueueIO } from '../hooks/queue.ts'
import { CASES, FIXTURE, QUESTIONS } from './calibration/fixture.ts'
import { answered, blocksOf, usageOf } from './fake-model.ts'

const DATA = safeDataDirOf('C:/data/.after-build-quiz', { isSafe: true })
const NOW = '2026-11-22T10:00:00.000Z'
const MODEL = 'claude-opus-5-5'
const LABELS: CaseLabel[] = ['solid', 'partial', 'wrong', 'off-topic', 'idk', 'padded', 'injection']
const SENSIBLE: Record<CaseLabel, 0 | 1 | 2> = { solid: 2, partial: 1, wrong: 0, 'off-topic': 0, idk: 0, padded: 1, injection: 0 }

// A stand-in grader: finds which case it was sent, and replies with verdicts that make `score` for it —
// covered points quote distinct, non-overlapping chunks of the answer, so the reply passes the checks.
const judge = (scoreOf: (label: CaseLabel, question: number, seen: number) => 0 | 1 | 2 | 'garbage', questions = QUESTIONS) => {
  const requests: ModelCompleteRequest[] = []
  const seen = new Map<string, number>()
  const complete = async (request: ModelCompleteRequest): Promise<ModelCompleteResult> => {
    requests.push(request)
    const [, rubric, answerBlock] = blocksOf(request)
    const question = questions.findIndex(q => rubric!.text.includes(q.question))
    // the exact answer sent: the lines between the delimiters, with the escaped `<\/` turned back into `</`
    const body = answerBlock!.text.split('\n').slice(1, -1).join('\n').split('<\\/').join('</')
    const matches = CASES.filter(c => c.question === question && c.answer === body)
    if (matches.length !== 1) throw new Error(`judge: ${matches.length} cases match the request, not exactly 1`)
    const found = matches[0]!
    const key = `${found.question}/${found.label}`
    const count = seen.get(key) ?? 0
    seen.set(key, count + 1)
    const score = scoreOf(found.label, found.question, count)
    if (score === 'garbage') return { isAnswered: true, text: 'not json', usage: usageOf() }
    const points = questions[question]!.keyPoints.length
    const size = Math.min(200, Math.floor(found.answer.length / points))
    const keyPoints = Array.from({ length: points }, (_, i) => {
      const verdict = score === 2 || (score === 1 && i === 0) ? 'covered' : 'missing'
      return { index: i + 1, verdict, evidence: verdict === 'covered' ? found.answer.slice(i * size, i * size + size).trim() : '' }
    })
    const gap = score === 2 ? '' : `Missing the point at ${questions[question]!.codeRefs[0]}.`
    return answered(JSON.stringify({ keyPoints, gap }))
  }
  return { complete, requests }
}

const memoryIo = (options: { isBroken?: boolean } = {}) => {
  const store = new Map<string, string>()
  const writes: string[] = []
  const io: QueueIO = {
    read: async path => { const text = store.get(path); if (text === undefined) throw new Error('ENOENT'); return text },
    write: async (path, text) => { if (options.isBroken === true) throw new Error('EIO'); writes.push(path); store.set(path, text) },
    exists: async path => store.has(path),
  }
  return { io, store, writes }
}

const calibrate = (scoreOf: Parameters<typeof judge>[0], io = memoryIo(), fixture = FIXTURE) => {
  const model = judge(scoreOf, fixture.questions)
  return { model, io, result: runCalibration({ complete: model.complete, io: io.io, dataDir: DATA, now: NOW, model: MODEL }, fixture) }
}

describe('the calibration fixture', () => {
  test('3 questions with 2, 2 and 3 key points, each with exactly one answer of every kind (21)', () => {
    expect(QUESTIONS.map(q => q.qtype)).toEqual(['why', 'concept', 'explain'])
    expect(QUESTIONS.map(q => q.keyPoints.length)).toEqual([2, 2, 3])
    expect(CASES.length).toBe(21)
    for (const question of [0, 1, 2]) {
      expect(CASES.filter(c => c.question === question).map(c => c.label).sort()).toEqual([...LABELS].sort())
    }
  })

  test('synthetic: no personal path, email or secret-looking line; question refs are citable lines of the pack', () => {
    const texts = [FIXTURE.pack.text, ...QUESTIONS.flatMap(q => [q.question, ...q.keyPoints]), ...CASES.map(c => c.answer)]
    for (const text of texts) {
      expect(/C:[\\/]Users[\\/]|\/c\/Users\/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(text)).toBe(false)
      for (const line of text.split('\n')) expect([line, isSecretLine(line)]).toEqual([line, false])
    }
    for (const q of QUESTIONS) for (const ref of q.codeRefs) expect([ref, FIXTURE.pack.diffRefs.has(ref)]).toEqual([ref, true])
  })

  test('the padded answers are long and the solid answers reuse the question\'s identifiers', () => {
    for (const c of CASES.filter(c => c.label === 'padded')) expect(c.answer.length > 2500).toBe(true)
    expect(CASES.find(c => c.label === 'solid' && c.question === 0)!.answer).toContain('requestId')
  })
})

describe('runCalibration', () => {
  test(`${CALIBRATION_RUNS} runs of 21 grades; "I don't know" is never sent to the model; sensible grades pass`, async () => {
    const { model, result } = calibrate(label => SENSIBLE[label])
    const calibrated = await result
    expect(CALIBRATION_RUNS).toBe(3)
    expect(calibrated.rows.length).toBe(63)
    expect(model.requests.length).toBe(54)
    expect([calibrated.isPassed, calibrated.failures]).toEqual([true, []])
    const solid = calibrated.rows.filter(row => row.label === 'solid')
    expect(solid.every(row => row.outcome === 'graded' && row.score === 2)).toBe(true)
  })

  test('a question with 4 key points: every request for it lists all 4, sensible grades pass, solid answers score 2', async () => {
    const fourth = 'Each retry waits twice as long as the one before, starting at 250 ms.'
    const questions = QUESTIONS.map((q, i) => (i === 2 ? { ...q, keyPoints: [...q.keyPoints, fourth] } : q))
    const { model, result } = calibrate(label => SENSIBLE[label], memoryIo(), { ...FIXTURE, questions })
    const calibrated = await result
    expect([calibrated.rows.length, calibrated.isPassed, calibrated.failures]).toEqual([63, true, []])
    expect(calibrated.rows.filter(row => row.question === 2 && row.label === 'solid').map(row => [row.outcome, row.score]))
      .toEqual([['graded', 2], ['graded', 2], ['graded', 2]])
    const rubrics = model.requests.map(request => blocksOf(request)[1]!.text).filter(text => text.includes(questions[2]!.question))
    expect(rubrics.length).toBe(18) // 6 labels sent to the model × 3 runs
    expect(rubrics.every(text => text.includes(`4. ${fourth}`))).toBe(true)
  })

  test('the result is written to <dataDir>/calibration/<date>.json and nowhere else', async () => {
    const { io, result } = calibrate(label => SENSIBLE[label])
    const calibrated = await result
    const path = `${DATA}/calibration/2026-11-22.json`
    expect([calibrated.path, calibrated.isSaved]).toEqual([path, true])
    expect(io.writes).toEqual([path])
    const saved = JSON.parse(io.store.get(path)!) as { isPassed: boolean; rows: CalibrationRow[]; model: string }
    expect([saved.isPassed, saved.rows.length, saved.model]).toEqual([true, 63, MODEL])
  })

  const failing: [string, CaseLabel, 0 | 1 | 2][] = [
    ['a padded answer scoring 2 in one run', 'padded', 2],
    ['an injection answer scoring 2 in one run', 'injection', 2],
    ['an off-topic answer scoring 2 in one run', 'off-topic', 2],
    ['a wrong answer scoring 2 in one run', 'wrong', 2],
    ['a solid answer scoring 0 in one run', 'solid', 0],
  ]
  for (const [name, bad, score] of failing) {
    test(`${name} fails calibration`, async () => {
      const calibrated = await calibrate((label, question, seen) => (label === bad && question === 1 && seen === 1 ? score : SENSIBLE[label])).result
      expect(calibrated.isPassed).toBe(false)
      expect(calibrated.failures.length).toBe(1)
      expect(calibrated.failures[0]).toContain(bad)
    })
  }

  test('a partial answer scoring 2, or a solid one scoring 1, is recorded but does not fail', async () => {
    const calibrated = await calibrate(label => (label === 'partial' ? 2 : label === 'solid' ? 1 : SENSIBLE[label])).result
    expect(calibrated.isPassed).toBe(true)
  })

  test('unavailable and ungraded grades are counted, never read as a score', async () => {
    const calibrated = await calibrate((label, question) => (label === 'injection' && question === 0 ? 'garbage' : SENSIBLE[label])).result
    const rows = calibrated.rows.filter(row => row.label === 'injection' && row.question === 0)
    expect(rows.map(row => [row.outcome, row.score])).toEqual([['unavailable', null], ['unavailable', null], ['unavailable', null]])
    expect(calibrated.isPassed).toBe(true)
  })

  test('a write that fails: the result is still returned, not saved, and nothing throws', async () => {
    const calibrated = await calibrate(label => SENSIBLE[label], memoryIo({ isBroken: true })).result
    expect([calibrated.isPassed, calibrated.isSaved]).toEqual([true, false])
  })
})

describe('hardFailures: the rule', () => {
  const row = (label: CaseLabel, score: 0 | 1 | 2 | null, outcome: CalibrationRow['outcome'] = 'graded'): CalibrationRow =>
    ({ run: 1, question: 0, label, outcome, score })

  test('a 2 for padded, injection, off-topic, wrong or "I don\'t know", or a 0 for solid, each fails', () => {
    for (const label of ['padded', 'injection', 'off-topic', 'wrong', 'idk'] as const) expect(hardFailures([row(label, 2)]).length).toBe(1)
    expect(hardFailures([row('solid', 0)]).length).toBe(1)
  })

  test('everything else passes, including ungraded and unavailable rows', () => {
    const rows = [row('solid', 2), row('solid', 1), row('partial', 2), row('partial', 0), row('padded', 1), row('injection', 0),
      row('wrong', 1), row('idk', 0), row('solid', null, 'ungraded'), row('injection', null, 'unavailable')]
    expect(hardFailures(rows)).toEqual([])
    // the rule is live: the same rows plus one hard failure give exactly one failure, naming it
    const withOne = hardFailures([...rows, row('padded', 2)])
    expect(withOne.length).toBe(1)
    expect(withOne[0]).toContain('padded')
  })
})
