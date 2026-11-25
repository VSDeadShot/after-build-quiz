// Grader calibration (SPEC acceptance tests): grade a fixed, synthetic set of answers with the real grader,
// 3 runs, and record every score to <dataDir>/calibration/<date>.json. The hard-fail rule is asserted; the
// expected bands are recorded, not asserted. Run with devMode on only (it costs real model calls).
import type { ActiveQuestion } from './active.ts'
import type { ContextPack } from './context.ts'
import type { SafeDataDir } from './paths.ts'
import { gradeAnswer } from './quiz.ts'
import type { Complete } from './quiz.ts'
import type { QueueIO } from './queue.ts'

export type CaseLabel = 'solid' | 'partial' | 'wrong' | 'off-topic' | 'idk' | 'padded' | 'injection'
export type CalibrationCase = { question: number; label: CaseLabel; answer: string }
export type CalibrationFixture = { pack: ContextPack; questions: ActiveQuestion[]; cases: CalibrationCase[] }
export type CalibrationRow = {
  run: number; question: number; label: CaseLabel; outcome: 'graded' | 'ungraded' | 'unavailable'; score: 0 | 1 | 2 | null
}
export type CalibrationDeps = { complete: Complete; io: QueueIO; dataDir: SafeDataDir; now: string; model: string }
export type CalibrationResult = { isPassed: boolean; failures: string[]; rows: CalibrationRow[]; path: string; isSaved: boolean }

export const CALIBRATION_RUNS = 3

// The expected bands (SPEC acceptance tests): recorded with the results, never asserted.
const EXPECTED: Partial<Record<CaseLabel, 0 | 1 | 2>> = { solid: 2, partial: 1, wrong: 0, 'off-topic': 0, idk: 0 }
const NEVER_TWO: readonly CaseLabel[] = ['padded', 'injection', 'off-topic', 'wrong', 'idk']

// Hard failures: a 2 for an answer that must never earn one, or a 0 for a solid answer, in any run.
// Ungraded and unavailable rows carry no score, so they never fail.
export const hardFailures = (rows: readonly CalibrationRow[]): string[] => rows
  .filter(row => row.outcome === 'graded' &&
    ((row.score === 2 && NEVER_TWO.includes(row.label)) || (row.score === 0 && row.label === 'solid')))
  .map(row => `run ${row.run}, question ${row.question + 1}: ${row.label} scored ${row.score}`)

// Grades one at a time (no burst of calls). Never throws: a failed write returns the result unsaved.
export const runCalibration = async (deps: CalibrationDeps, fixture: CalibrationFixture): Promise<CalibrationResult> => {
  const rows: CalibrationRow[] = []
  for (let run = 1; run <= CALIBRATION_RUNS; run++) {
    for (const item of fixture.cases) {
      const question = fixture.questions[item.question]
      const graded = question === undefined
        ? { kind: 'unavailable' as const, reason: 'no-question' }
        : await gradeAnswer(deps.complete, fixture.pack, question, item.answer, deps.model)
      rows.push({
        run, question: item.question, label: item.label, outcome: graded.kind,
        score: graded.kind === 'graded' ? graded.score : null,
      })
    }
  }
  const failures = hardFailures(rows)
  const isPassed = failures.length === 0
  const path = `${deps.dataDir}/calibration/${deps.now.slice(0, 10)}.json`
  const saved = { v: 1, date: deps.now, model: deps.model, runs: CALIBRATION_RUNS, isPassed, failures, expected: EXPECTED, rows }
  let isSaved = false
  try {
    await deps.io.write(path, `${JSON.stringify(saved, null, 2)}\n`)
    isSaved = true
  } catch {
    isSaved = false
  }
  return { isPassed, failures, rows, path, isSaved }
}
