import type { Register } from 'claude-code'

import { readSettings } from './settings.ts'

export const register: Register = (_on, options) => {
  readSettings(options)
}
