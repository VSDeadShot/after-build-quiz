import { describe, expect, test } from 'claude-code/testing'

import { REDACTED } from '../hooks/context.ts'
import { appendAttempt, LOG_LIMITS, readLog } from '../hooks/log.ts'
import type { Attempt, LogIO } from '../hooks/log.ts'
import { safeDataDirOf } from '../hooks/paths.ts'

const DIR = safeDataDirOf('C:/data', { isSafe: true })
const NOW = '2026-11-02T10:00:00.000Z'
const MAIN = 'C:/data/log/2026-11.jsonl'
const TMP = `${MAIN}.tmp`
const ASIDE = 'C:/data/log/2026-11.corrupt-2026-11-02T10-00-00-000Z.jsonl'
const FIELDS = ['v', 'id', 'date', 'repo', 'repoName', 'commit', 'subject', 'qtype', 'concept', 'question', 'answer',
  'score', 'gap', 'codeRefs']

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  id: 'a1',
  date: '2026-11-02T09:14:03.120Z',
  repo: 'C:/work/foo',
  repoName: 'foo',
  commit: 'c'.repeat(40),
  subject: 'Add retry to fetch',
  qtype: 'why',
  concept: 'idempotency-retries',
  question: 'Why does fetch retry only GET requests?',
  answer: 'Because a POST is not idempotent.',
  score: 1,
  gap: 'Missed the backoff cap at src/fetch.ts:41.',
  codeRefs: ['src/fetch.ts:41'],
  ...over,
})
const lineOf = (a: Attempt) => `${JSON.stringify({ v: 1, ...a })}\n`

// In-memory fs: a crash keeps the first half of what was being written and throws, as a killed process
// would leave it; a failing write changes nothing.
const fakeFs = (files: Record<string, string> = {}) => {
  const store = new Map(Object.entries(files))
  const writes: string[] = []
  const crashes = new Set<string>()
  const failures = new Set<string>()
  const unreadable = new Set<string>()
  let isBroken = false
  const io: LogIO = {
    read: async path => {
      if (isBroken || unreadable.has(path)) throw new Error('EIO')
      const text = store.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    write: async (path, text) => {
      if (isBroken) throw new Error('EIO')
      writes.push(path)
      if (failures.has(path)) throw new Error('EACCES')
      if (crashes.has(path)) {
        crashes.delete(path)
        store.set(path, text.slice(0, Math.floor(text.length / 2)))
        throw new Error('killed')
      }
      store.set(path, text)
    },
    exists: async path => {
      if (isBroken) throw new Error('EIO')
      return store.has(path) || unreadable.has(path)
    },
    list: async dir => {
      if (isBroken) throw new Error('EIO')
      const prefix = `${dir}/`
      return [...store.keys()].filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map(key => key.slice(prefix.length))
    },
  }
  return {
    io, store, writes,
    crashOn: (path: string) => crashes.add(path),
    failOn: (path: string) => failures.add(path),
    makeUnreadable: (path: string) => unreadable.add(path),
    breakAll: () => { isBroken = true },
  }
}

const append = (io: LogIO, a: Attempt) => appendAttempt(io, DIR, a, { now: NOW })
const linesIn = (text: string | undefined) => (text ?? '').split('\n').filter(line => line !== '')

describe('appendAttempt: format', () => {
  test('the first attempt creates log/YYYY-MM.jsonl: one line, v first, the SPEC fields in order', async () => {
    const fs = fakeFs()
    const result = await append(fs.io, attempt())
    expect(result.isLogged).toBe(true)
    expect(fs.store.get(MAIN)).toBe(lineOf(attempt()))
    expect(Object.keys(JSON.parse(linesIn(fs.store.get(MAIN))[0]!))).toEqual(FIELDS)
  })

  test('the month is the UTC month of date; date is stored in UTC', async () => {
    const fs = fakeFs()
    await append(fs.io, attempt({ id: 'end', date: '2026-11-30T23:59:59.999Z' }))
    await append(fs.io, attempt({ id: 'start', date: '2026-12-01T00:00:00.000Z' }))
    await append(fs.io, attempt({ id: 'offset', date: '2026-12-01T04:00:00+05:30' })) // 2026-11-30T22:30Z
    const november = linesIn(fs.store.get(MAIN)).map(line => JSON.parse(line))
    expect(november.map(entry => entry.id)).toEqual(['end', 'offset'])
    expect(november[1].date).toBe('2026-11-30T22:30:00.000Z')
    expect(linesIn(fs.store.get('C:/data/log/2026-12.jsonl')).map(line => JSON.parse(line).id)).toEqual(['start'])
  })

  test('a second attempt keeps the first, in order; each write goes to .tmp first, then the month file', async () => {
    const fs = fakeFs()
    await append(fs.io, attempt())
    await append(fs.io, attempt({ id: 'a2', qtype: 'concept' }))
    expect(fs.store.get(MAIN)).toBe(lineOf(attempt()) + lineOf(attempt({ id: 'a2', qtype: 'concept' })))
    expect(fs.store.get(TMP)).toBe(fs.store.get(MAIN))
    expect(fs.writes).toEqual([TMP, MAIN, TMP, MAIN])
  })

  test('an ungraded attempt is written with score and gap null and no code refs', async () => {
    const fs = fakeFs()
    const ungraded = attempt({ score: null, gap: null, codeRefs: [] })
    expect((await append(fs.io, ungraded)).isLogged).toBe(true)
    const entry = JSON.parse(linesIn(fs.store.get(MAIN))[0]!)
    expect([entry.score, entry.gap, entry.codeRefs]).toEqual([null, null, []])
  })

  test('a Ctrl+J multi-line answer round-trips exactly, on one line of the file', async () => {
    const fs = fakeFs()
    const answer = 'line one\nline two\r\n  line three'
    await append(fs.io, attempt({ answer }))
    expect(linesIn(fs.store.get(MAIN)).length).toBe(1)
    expect((await readLog(fs.io, DIR)).entries[0]!.answer).toBe(answer)
  })

  test('an attempt that is not well formed is not logged and nothing is written', async () => {
    const fs = fakeFs()
    expect((await append(fs.io, attempt({ date: 'yesterday' }))).isLogged).toBe(false)
    expect((await append(fs.io, attempt({ score: 3 as never }))).isLogged).toBe(false)
    expect((await append(fs.io, attempt({ id: '' }))).isLogged).toBe(false)
    expect(fs.writes).toEqual([])
  })
})

describe('appendAttempt: crash safety and damaged files', () => {
  test('a crash while writing the month file: .tmp is used, nothing is lost, the retry is a duplicate', async () => {
    const fs = fakeFs()
    await append(fs.io, attempt())
    fs.crashOn(MAIN)
    expect((await append(fs.io, attempt({ id: 'a2' }))).isLogged).toBe(false)
    expect((await readLog(fs.io, DIR)).entries.map(entry => entry.id)).toEqual(['a1', 'a2'])
    expect(await append(fs.io, attempt({ id: 'a2' }))).toEqual({ isLogged: true, isDuplicate: true })
    await append(fs.io, attempt({ id: 'a3' }))
    expect(linesIn(fs.store.get(MAIN)).map(line => JSON.parse(line).id)).toEqual(['a1', 'a2', 'a3'])
    expect(fs.store.has(ASIDE)).toBe(false)
  })

  test('a crash while writing .tmp: the month file is untouched and the attempt is not logged', async () => {
    const fs = fakeFs()
    await append(fs.io, attempt())
    const before = fs.store.get(MAIN)
    fs.crashOn(TMP)
    expect((await append(fs.io, attempt({ id: 'a2' }))).isLogged).toBe(false)
    expect(fs.store.get(MAIN)).toBe(before)
    expect((await readLog(fs.io, DIR)).entries.map(entry => entry.id)).toEqual(['a1'])
  })

  test('on read, lines that do not parse or are not log entries are skipped and counted', async () => {
    const fs = fakeFs({
      [MAIN]: lineOf(attempt()) + 'garbage\n' + `${JSON.stringify({ v: 1, ...attempt({ id: 'bad' }), score: 3 })}\n` +
        `${JSON.stringify({ ...attempt({ id: 'old' }), v: 2 })}\n` + lineOf(attempt({ id: 'a2' })),
    })
    const read = await readLog(fs.io, DIR)
    expect(read.entries.map(entry => entry.id)).toEqual(['a1', 'a2'])
    expect(read.skipped).toBe(3)
  })

  test('a month file with damaged lines is copied aside before the rewrite, with one notice', async () => {
    const damaged = lineOf(attempt()) + 'garbage\n' + lineOf(attempt({ id: 'a2' }))
    const fs = fakeFs({ [MAIN]: damaged })
    const result = await append(fs.io, attempt({ id: 'a3', answer: 'my private answer' }))
    expect(result.isLogged).toBe(true)
    expect(fs.store.get(ASIDE)).toBe(damaged)
    expect(linesIn(fs.store.get(MAIN)).map(line => JSON.parse(line).id)).toEqual(['a1', 'a2', 'a3'])
    expect(result.notice).toBe('after-build-quiz: log/2026-11.jsonl had 1 damaged line; saved it as ' +
      'log/2026-11.corrupt-2026-11-02T10-00-00-000Z.jsonl and kept the valid lines')
  })

  test('a cut-off last line never absorbs the next entry', async () => {
    const fs = fakeFs({ [MAIN]: lineOf(attempt()) + '{"v":1,"id":"half' })
    await append(fs.io, attempt({ id: 'a2' }))
    expect(fs.store.get(MAIN)).toBe(lineOf(attempt()) + lineOf(attempt({ id: 'a2' })))
    expect(fs.store.get(ASIDE)).toBe(lineOf(attempt()) + '{"v":1,"id":"half')
  })

  test('if the damaged file cannot be copied aside, nothing is rewritten and the attempt is not logged', async () => {
    const damaged = lineOf(attempt()) + 'garbage\n'
    const fs = fakeFs({ [MAIN]: damaged })
    fs.failOn(ASIDE)
    const result = await append(fs.io, attempt({ id: 'a2' }))
    expect(result.isLogged).toBe(false)
    expect(fs.store.get(MAIN)).toBe(damaged)
    expect(fs.writes).toEqual([ASIDE])
    expect(result.notice).toBe('after-build-quiz: log/2026-11.jsonl is damaged and could not be copied aside; ' +
      'this answer was not logged')
  })

  test('an unreadable month file is never overwritten; the attempt is not logged, with one notice', async () => {
    const fs = fakeFs({ [MAIN]: lineOf(attempt()) })
    fs.makeUnreadable(MAIN)
    const result = await append(fs.io, attempt({ id: 'a2' }))
    expect(result.isLogged).toBe(false)
    expect(fs.writes).toEqual([])
    expect(result.notice).toBe('after-build-quiz: could not read log/2026-11.jsonl (Error: EIO); ' +
      'this answer was not logged and the file was left as it is')
  })

  test('a failing file system never throws: not logged, and an empty read', async () => {
    const fs = fakeFs({ [MAIN]: lineOf(attempt()) })
    fs.breakAll()
    expect((await append(fs.io, attempt({ id: 'a2' }))).isLogged).toBe(false)
    expect(await readLog(fs.io, DIR)).toEqual({ entries: [], skipped: 0, unreadable: [] })
  })
})

describe('appendAttempt: duplicates and concurrency', () => {
  test('an id already in the month file is not appended again', async () => {
    const fs = fakeFs()
    await append(fs.io, attempt())
    const writes = fs.writes.length
    expect(await append(fs.io, attempt({ answer: 'resent after a crash' }))).toEqual({ isLogged: true, isDuplicate: true })
    expect(fs.writes.length).toBe(writes)
    expect(linesIn(fs.store.get(MAIN)).length).toBe(1)
  })

  test('two attempts started together in one session both land, in call order', async () => {
    const fs = fakeFs()
    const results = await Promise.all([append(fs.io, attempt()), append(fs.io, attempt({ id: 'a2' }))])
    expect(results.map(result => result.isLogged)).toEqual([true, true])
    expect(linesIn(fs.store.get(MAIN)).map(line => JSON.parse(line).id)).toEqual(['a1', 'a2'])
  })
})

describe('appendAttempt: redaction and size', () => {
  // Assembled at runtime so secret scanners do not flag this file; none is a real credential.
  const GOOGLE = 'AIza' + 'B'.repeat(35)
  const TOKEN_LINE = 'API_TOKEN=' + 'tok' + '_live_' + 'do_not_leak'
  const BEARER = 'Authorization: Bearer ' + 'q9W8e7R6t5Y4u3I2o1P0'
  const SK = 'sk-' + 'ant-' + 'a1'.repeat(12)

  test('secret-looking lines of the answer, gap, question and subject are replaced before writing', async () => {
    const fs = fakeFs()
    await append(fs.io, attempt({
      answer: `It reads the key:\n${GOOGLE}\nthen retries.`,
      gap: `You pasted:\n${TOKEN_LINE}`, // 4a matches an env line on its own, not one inside a sentence
      question: `Why send ${BEARER} on every call?`,
      subject: `Use ${SK} for the client`,
    }))
    const text = fs.store.get(MAIN)!
    for (const secret of ['AIza', 'tok_live', 'q9W8e7R6t5Y4u3I2o1P0', 'sk-ant-']) expect(text).not.toContain(secret)
    const entry = (await readLog(fs.io, DIR)).entries[0]!
    expect(entry.answer).toBe(`It reads the key:\n${REDACTED}\nthen retries.`)
    expect([entry.gap, entry.question, entry.subject]).toEqual([`You pasted:\n${REDACTED}`, REDACTED, REDACTED])
  })

  // Was the KNOWN GAP until 3c4 (rule 4c): a mid-line assignment is redacted like a line-start one.
  test('an assignment-style secret inside a sentence is redacted (4c)', async () => {
    const fs = fakeFs()
    await append(fs.io, attempt({ gap: `You pasted ${TOKEN_LINE} here.` }))
    expect((await readLog(fs.io, DIR)).entries[0]!.gap).toBe(REDACTED)
    expect(fs.store.get(MAIN)).not.toContain('tok' + '_live')
  })

  test('long fields are cut after redaction: answer 8,000, question and gap 2,000, with the marker', async () => {
    const fs = fakeFs()
    await append(fs.io, attempt({
      answer: `${GOOGLE}\n${'a'.repeat(9_000)}`, question: 'q'.repeat(2_500), gap: 'g'.repeat(2_001),
    }))
    const entry = (await readLog(fs.io, DIR)).entries[0]!
    const redactedLength = REDACTED.length + 1 + 9_000
    expect(entry.answer).toBe(`${REDACTED}\n${'a'.repeat(8_000 - REDACTED.length - 1)} [… ${redactedLength - 8_000} characters cut]`)
    expect(entry.question).toBe(`${'q'.repeat(2_000)} [… 500 characters cut]`)
    expect(entry.gap).toBe(`${'g'.repeat(2_000)} [… 1 characters cut]`)
    expect(LOG_LIMITS).toEqual({ answer: 8_000, question: 2_000, gap: 2_000, monthBytes: 3.5 * 1024 * 1024 })
  })

  test('a write that would take the month file past 3.5 MiB is not made: not logged, one notice', async () => {
    // whole lines of one size, as many as fit; the next line of that size does not
    const sample = (i: number) => lineOf(attempt({ id: `f${String(i).padStart(4, '0')}`, answer: 'x'.repeat(7_000) }))
    const count = Math.floor(LOG_LIMITS.monthBytes / sample(0).length)
    const full = Array.from({ length: count }, (_, i) => sample(i)).join('')
    expect(full.length).toBeLessThan(LOG_LIMITS.monthBytes + 1)
    const fs = fakeFs({ [MAIN]: full })
    const result = await append(fs.io, attempt({ id: 'f9999', answer: 'x'.repeat(7_000) }))
    expect(result.isLogged).toBe(false)
    expect(fs.writes).toEqual([])
    expect(result.notice).toBe('after-build-quiz: log/2026-11.jsonl has reached its size limit (3.5 MiB); ' +
      'this answer was not logged')
  })

  test('the size limit counts UTF-8 bytes, not characters', async () => {
    const wide = '€'.repeat(2_000) // 3 bytes each
    const sample = (i: number) => lineOf(attempt({ id: `w${String(i).padStart(4, '0')}`, answer: wide }))
    const count = Math.floor(LOG_LIMITS.monthBytes / (sample(0).length + 4_000)) // each € is 2 bytes more than 1 character
    const full = Array.from({ length: count }, (_, i) => sample(i)).join('')
    expect(full.length).toBeLessThan(LOG_LIMITS.monthBytes / 2) // far under the limit in characters
    const fs = fakeFs({ [MAIN]: full })
    expect((await append(fs.io, attempt({ id: 'w9999', answer: wide }))).isLogged).toBe(false)
  })
})

describe('readLog', () => {
  test('reads every month, ignores .tmp, corrupt copies and other files, and sorts by date', async () => {
    const oct = attempt({ id: 'oct', date: '2026-10-05T08:00:00.000Z' })
    const novLate = attempt({ id: 'nov-late', date: '2026-11-20T08:00:00.000Z' })
    const novEarly = attempt({ id: 'nov-early', date: '2026-11-01T08:00:00.000Z' })
    const aug = attempt({ id: 'aug', date: '2026-08-09T08:00:00.000Z' })
    const fs = fakeFs({
      'C:/data/log/2026-10.jsonl': lineOf(oct),
      [MAIN]: lineOf(novLate) + lineOf(novEarly),
      [TMP]: lineOf(novLate) + lineOf(novEarly),
      'C:/data/log/2026-08.jsonl.tmp': lineOf(aug), // a first write cut off before the month file existed
      'C:/data/log/2026-09.corrupt-2026-09-30T00-00-00-000Z.jsonl': lineOf(attempt({ id: 'aside' })),
      'C:/data/log/notes.txt': 'hello',
      'C:/data/queue.json': '{}',
    })
    const read = await readLog(fs.io, DIR)
    expect(read.entries.map(entry => entry.id)).toEqual(['aug', 'oct', 'nov-early', 'nov-late'])
    expect(read.skipped).toBe(0)
  })

  test('an unreadable month is reported and the others are still read; no log folder reads as empty', async () => {
    const fs = fakeFs({ [MAIN]: lineOf(attempt()), 'C:/data/log/2026-10.jsonl': lineOf(attempt({ id: 'oct' })) })
    fs.makeUnreadable('C:/data/log/2026-10.jsonl')
    const read = await readLog(fs.io, DIR)
    expect(read.entries.map(entry => entry.id)).toEqual(['a1'])
    expect(read.unreadable).toEqual(['log/2026-10.jsonl'])
    expect(await readLog(fakeFs().io, DIR)).toEqual({ entries: [], skipped: 0, unreadable: [] })
  })

  test('every write lands under <dataDir>/log/', async () => {
    const fs = fakeFs({ [MAIN]: lineOf(attempt({ id: 'a0' })) + 'garbage\n' })
    await append(fs.io, attempt())
    await append(fs.io, attempt({ id: 'dec', date: '2026-12-02T00:00:00.000Z' }))
    expect(fs.writes.length).toBeGreaterThan(0)
    expect(fs.writes.every(path => path.startsWith('C:/data/log/'))).toBe(true)
  })

  test('only a checked data folder is accepted (type-level: tsc checks these directives)', () => {
    const unchecked = (io: LogIO) => {
      // @ts-expect-error a plain string is not a SafeDataDir
      void appendAttempt(io, 'C:/data', attempt(), { now: NOW })
      // @ts-expect-error a plain string is not a SafeDataDir
      void readLog(io, 'C:/data')
    }
    expect(typeof unchecked).toBe('function')
  })
})
