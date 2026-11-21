// Test helper (not a test file): a stand-in for $.model.complete. It records every request and
// answers from a script, one reply per call; a call past the end of the script fails the test.
import type { ModelCompleteRequest, ModelCompleteResult, ModelUsage } from 'claude-code'

export const usageOf = (output = 900): ModelUsage => ({
  input_tokens: 5000, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
})

export const answered = (text: string, output = 900): ModelCompleteResult => ({ isAnswered: true, text, usage: usageOf(output) })
export const apiError = (): ModelCompleteResult => ({
  isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: usageOf(0),
})
export const emptyReply = (): ModelCompleteResult => ({ isAnswered: false, reason: 'empty-reply', usage: usageOf(40) })
export const aborted = (): ModelCompleteResult => ({ isAnswered: false, reason: 'aborted', usage: usageOf(0) })

// One scripted step: a result, an error to reject with, or a value that is no result at all.
export type Step = ModelCompleteResult | { rejects: string } | { garbage: unknown }

export const fakeModel = (...script: Step[]) => {
  const requests: ModelCompleteRequest[] = []
  const complete = async (request: ModelCompleteRequest): Promise<ModelCompleteResult> => {
    requests.push(request)
    const step = script[requests.length - 1]
    if (step === undefined) throw new Error(`fakeModel: unexpected call ${requests.length}`)
    if ('rejects' in step) throw new Error(step.rejects)
    if ('garbage' in step) return step.garbage as ModelCompleteResult
    return step
  }
  return { complete, requests }
}

// The prompt's blocks as the request sent them (the generator always sends a list).
export const blocksOf = (request: ModelCompleteRequest) => {
  if (typeof request.prompt === 'string') throw new Error('expected prompt blocks, got a string')
  return request.prompt
}
