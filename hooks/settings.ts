import type { PluginOptions } from 'claude-code'

export type Settings = {
  dataDir: string
  minChangedLines: number
  queueCap: number
  model: string
  devMode: boolean
}

// Mirrors the defaults in .claude-plugin/plugin.json userConfig.
export const DEFAULTS: Readonly<Settings> = {
  dataDir: '',
  minChangedLines: 10,
  queueCap: 10,
  model: 'claude-opus-5-5',
  devMode: false,
}

const wholeNumber = (name: string, value: unknown, min: number, fallback: number): number => {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`after-build-quiz: ${name} must be a whole number >= ${min}, got ${String(value)}`)
  }
  return value
}

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value.trim() : fallback

export const readSettings = (options: PluginOptions): Settings => ({
  dataDir: text(options.dataDir, DEFAULTS.dataDir),
  minChangedLines: wholeNumber('minChangedLines', options.minChangedLines, 0, DEFAULTS.minChangedLines),
  queueCap: wholeNumber('queueCap', options.queueCap, 1, DEFAULTS.queueCap),
  model: text(options.model, DEFAULTS.model) || DEFAULTS.model,
  devMode: typeof options.devMode === 'boolean' ? options.devMode : DEFAULTS.devMode,
})
