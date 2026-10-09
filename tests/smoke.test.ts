import { expect, test } from 'claude-code/testing'

import { DEFAULTS, readSettings } from '../hooks/settings.ts'

test('the plugin loads', async ($, on) => {
  let isReached = false
  on('classic.SessionStart', () => {
    isReached = true
    return {}
  })
  // the first call on $ loads the plugin under test; a load failure fails here
  await $.classic.SessionStart({ source: 'startup' })
  expect(isReached).toBe(true)
})

test('readSettings fills the documented defaults', () => {
  expect(readSettings({})).toEqual({
    dataDir: '',
    minChangedLines: 10,
    queueCap: 10,
    model: 'claude-opus-5-5',
    devMode: false,
  })
  expect(DEFAULTS.queueCap).toBe(10)
})

test('readSettings keeps valid values', () => {
  const settings = readSettings({ dataDir: 'D:/quiz', minChangedLines: 5, queueCap: 3, devMode: true })
  expect(settings.dataDir).toBe('D:/quiz')
  expect(settings.minChangedLines).toBe(5)
  expect(settings.queueCap).toBe(3)
  expect(settings.devMode).toBe(true)
})

test('readSettings rejects out-of-range numbers', () => {
  expect(() => readSettings({ queueCap: 0 })).toThrow()
  expect(() => readSettings({ minChangedLines: -1 })).toThrow()
  expect(() => readSettings({ queueCap: 2.5 })).toThrow()
})
