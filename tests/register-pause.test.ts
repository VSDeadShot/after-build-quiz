import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin, PromptSubmitInput } from 'claude-code'

import type { ActiveFile, ActiveQuiz } from '../hooks/active.ts'
import { emptyQueue, saveQueue } from '../hooks/queue.ts'
import { register } from '../hooks/register.ts'
import { commit, makeRepo } from './fake-git.ts'
import { ACTIVE, ACTIVE_TMP, CANARY, DRAFT, fileText, HASH, quizOf, UNSENT } from './quiz-fixture.ts'
import { DATA, OLD, pendingEntry, SESSION, STARTED, world } from './world.ts'

type World = ReturnType<typeof world>

const START = { cwd: 'C:\\work\\foo', surface: 'terminal', isInteractive: true } as const
const END = { reason: 'prompt_input_exit', sessionId: SESSION, resume: { id: SESSION } } as const
const PAUSED_AT = new Date(STARTED).toISOString()
const PAUSED = 'quiz paused · /quiz to resume'

const prompt = (text: string, origin: PromptOrigin = { kind: 'composer' }, extra: Partial<PromptSubmitInput> = {}): PromptSubmitInput =>
  ({ text, wait: false, origin, ...extra })

const seedQuiz = (w: World, quiz: ActiveQuiz | null, seq = 1) => { w.fs.store.set(ACTIVE, fileText(quiz, seq)) }
const seedPending = (w: World, count: number) =>
  saveQueue(w.fs.io, DATA, {
    ...emptyQueue(),
    pending: [pendingEntry(HASH), ...Array.from({ length: count - 1 }, (_, index) => pendingEntry(String(index).repeat(40)))],
  })
const activeOf = (w: World): ActiveFile => JSON.parse(w.fs.store.get(ACTIVE)!)
const activeWrites = (w: World) => w.fs.writes.filter(path => path.includes('/active'))
const shown = (w: World) => w.logs.filter(log => log.to !== 'debug')

// a session that starts with its own quiz running (what /quiz leaves behind, from 3i on)
const startLive = async ($: Engine, w: World, quiz = quizOf()) => {
  seedQuiz(w, quiz)
  await $.session.start(START)
  await w.settle()
}

describe('prompt.submit: a prompt from the person pauses the running quiz', () => {
  test('the prompt passes unchanged; the pause is written only after it entered and the timer; the status says paused', async ($, on) => {
    const w = world(on, [])
    await seedPending(w, 1)
    await startLive($, w)
    const sent = prompt('fix the login bug')

    const entered = await $.prompt.submit(sent)

    expect(entered).toEqual({ text: 'fix the login bug' })
    expect(w.prompts).toEqual([sent])
    expect(activeOf(w).quiz!.isPaused).toBe(false)
    expect(activeWrites(w)).toEqual([])

    await w.settle()

    expect(activeOf(w)).toEqual({ version: 1, seq: 2, quiz: quizOf({ isPaused: true, pausedAt: PAUSED_AT }) })
    expect(activeWrites(w)).toEqual([ACTIVE_TMP, ACTIVE])
    expect(w.statuses.at(-1)).toBe(PAUSED)
    expect(shown(w)).toEqual([])
  })

  test('once paused, later prompts cost nothing: no file access, no git, no status change', async ($, on) => {
    const w = world(on, [])
    await startLive($, w)
    await $.prompt.submit(prompt('first'))
    await w.settle()
    const mark = w.order.length
    const statuses = w.statuses.length

    await $.prompt.submit(prompt('second'))
    await w.settle()

    expect(w.order.slice(mark)).toEqual(['prompt'])
    expect(w.statuses.length).toBe(statuses)
    expect(activeOf(w).seq).toBe(2)
  })

  test('pause mid-draft: only the flag and the time change; the held draft is kept exactly', async ($, on) => {
    const w = world(on, [])
    await startLive($, w, quizOf({ held: DRAFT }))
    await $.prompt.submit(prompt('what does this error mean?'))
    await w.settle()
    expect(activeOf(w).quiz).toEqual(quizOf({ held: DRAFT, isPaused: true, pausedAt: PAUSED_AT }))
  })

  test('pause after an answer the grader never saw: the unsent answer and its attempt id are kept', async ($, on) => {
    const w = world(on, [])
    const attempt = { id: 'attempt-7', date: '2026-10-10T08:29:00.000Z' }
    await startLive($, w, quizOf({ held: UNSENT, attempt }))
    await $.prompt.submit(prompt('carry on with the refactor'))
    await w.settle()
    expect(activeOf(w).quiz).toEqual(quizOf({ held: UNSENT, attempt, isPaused: true, pausedAt: PAUSED_AT }))
  })

  for (const origin of [{ kind: 'bridge' }, { kind: 'sdk' }, { kind: 'slack-ping' }] as PromptOrigin[]) {
    test(`a prompt from ${origin.kind} pauses too`, async ($, on) => {
      const w = world(on, [])
      await startLive($, w)
      await $.prompt.submit(prompt('hello', origin))
      await w.settle()
      expect(activeOf(w).quiz!.isPaused).toBe(true)
    })
  }

  test('a skill command from the person pauses', async ($, on) => {
    const w = world(on, [])
    await startLive($, w)
    await $.prompt.submit(prompt('/simplify', { kind: 'composer' }, { command: { name: 'simplify', args: '' } }))
    await w.settle()
    expect(activeOf(w).quiz!.isPaused).toBe(true)
  })
})

describe('prompt.submit: what does not pause', () => {
  const stays = async ($: Engine, w: World, sent: PromptSubmitInput) => {
    const before = w.fs.store.get(ACTIVE)
    const statuses = w.statuses.length
    const mark = w.order.length
    const entered = await $.prompt.submit(sent)
    await w.settle()
    expect(w.fs.store.get(ACTIVE)).toBe(before)
    expect(activeWrites(w)).toEqual([])
    expect(w.statuses.length).toBe(statuses)
    expect(w.order.slice(mark)).toEqual(['prompt'])
    return entered
  }

  for (const [name, seed] of [
    ['no active.json at all', undefined],
    ['an active.json with no quiz', null],
    ['a quiz this session already paused', quizOf({ isPaused: true, pausedAt: OLD })],
    ["another session's running quiz", quizOf({ sessionId: 'another-session' })],
  ] as const) {
    test(`with ${name}, a prompt is a no-op: no file access, no git, no status change, nothing created`, async ($, on) => {
      const w = world(on, [])
      if (seed !== undefined) seedQuiz(w, seed)
      await $.session.start(START)
      await w.settle()
      const files = [...w.fs.store.keys()].sort()

      const entered = await stays($, w, prompt('fix the login bug'))

      expect(entered).toEqual({ text: 'fix the login bug' })
      expect([...w.fs.store.keys()].sort()).toEqual(files)
    })
  }

  for (const sent of [
    prompt('/quiz'),
    prompt('/quiz the delay doubles so the server can recover.'),
    prompt('/quiz skip'),
    prompt('', { kind: 'composer' }, { command: { name: 'quiz', args: '' } }),
  ]) {
    test(`/quiz does not pause the quiz: ${JSON.stringify(sent.command?.name ?? sent.text)}`, async ($, on) => {
      const w = world(on, [])
      await startLive($, w)
      await stays($, w, sent)
    })
  }

  for (const origin of [
    { kind: 'plugin', name: 'other-plugin' }, { kind: 'plugin', name: 'other-plugin', asUser: true }, { kind: 'peer' },
    { kind: 'peer-send-message' }, { kind: 'task-notification' }, { kind: 'scheduled-trigger' },
    { kind: 'channel', server: 'slack' }, { kind: 'auto-continuation' }, { kind: 'unclassified' },
  ] as PromptOrigin[]) {
    const label = origin.kind === 'plugin' && origin.asUser === true ? 'plugin (asUser)' : origin.kind
    test(`a prompt that is not the person's does not pause: ${label}`, async ($, on) => {
      const w = world(on, [])
      await startLive($, w)
      await stays($, w, prompt('a message', origin))
    })
  }

  test('a prompt the person does not see as typed (isMeta) does not pause', async ($, on) => {
    const w = world(on, [])
    await startLive($, w)
    await stays($, w, prompt('continue', { kind: 'composer' }, { isMeta: true }))
  })

  test('a built-in that starts no model turn does not pause, even if a prompt event is raised for it', async ($, on) => {
    const w = world(on, [])
    await startLive($, w)
    await stays($, w, prompt('/help', { kind: 'composer' }, { command: { name: 'help', args: '' } }))
  })

  test('a prompt that was refused beneath never entered, so it does not pause; the refusal comes back as it is', async ($, on) => {
    const w = world(on, [], { dropPrompts: 'blocked by a settings hook' })
    await startLive($, w)
    const entered = await stays($, w, prompt('fix the login bug'))
    expect(entered).toEqual({ drop: 'blocked by a settings hook' })
  })

  test('no tool guard: a tool call never pauses the quiz', async ($, on) => {
    const w = world(on, [])
    await startLive($, w)
    const statuses = w.statuses.length

    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'PowerShell', command: 'Get-ChildItem' })
    await w.settle()

    expect(activeOf(w).quiz!.isPaused).toBe(false)
    expect(activeWrites(w)).toEqual([])
    expect(w.statuses.length).toBe(statuses)
  })

  test('the plugin hooks these events and no others: only a prompt or a session end can pause', () => {
    const events: string[] = []
    const recorder = ((event: string) => {
      events.push(event)
      return { catch: () => undefined }
    }) as unknown as On
    register(recorder, {})
    expect(events.sort()).toEqual(['classic.CwdChanged', 'prompt.submit', 'session.end', 'session.start', 'tool.call', 'tool.call'])
  })
})

describe('prompt.submit: never gates', () => {
  test('the file system failing: the prompt enters once, unchanged; nothing is thrown; one notice says the file could not be read', async ($, on) => {
    const w = world(on, [])
    await startLive($, w)
    w.breakFs()
    const sent = prompt('fix the login bug')

    const entered = await $.prompt.submit(sent)
    await w.settle()
    await $.prompt.submit(prompt('and again'))
    await w.settle()

    expect(entered).toEqual({ text: 'fix the login bug' })
    expect(w.prompts[0]).toEqual(sent)
    expect(w.prompts.length).toBe(2)
    expect(shown(w).length).toBe(1)
    expect(shown(w)[0]!.text.startsWith('after-build-quiz: could not read active.json (')).toBe(true)
  })

  test('the session id failing: the prompt still enters once, unchanged', async ($, on) => {
    const w = world(on, [])
    await startLive($, w)
    w.breakSessionId()
    const sent = prompt('fix the login bug')

    const entered = await $.prompt.submit(sent)
    await w.settle()

    expect(entered).toEqual({ text: 'fix the login bug' })
    expect(w.prompts).toEqual([sent])
    expect(shown(w)).toEqual([])
  })

  test('git failing (the data folder cannot be checked): nothing is written, the prompt is untouched', async ($, on) => {
    const w = world(on, [])
    seedQuiz(w, quizOf())
    w.breakGit()
    await $.session.start(START)
    await w.settle()

    const entered = await $.prompt.submit(prompt('fix the login bug'))
    await w.settle()

    expect(entered).toEqual({ text: 'fix the login bug' })
    expect(w.fs.writes).toEqual([])
  })

  test('a data folder inside a repo: nothing is written there, on a prompt or at session end', async ($, on) => {
    const w = world(on, [makeRepo('C:/Users/someone')])
    await startLive($, w)

    await $.prompt.submit(prompt('fix the login bug'))
    await w.settle()
    await $.session.end(END)

    expect(w.fs.writes).toEqual([])
    expect(shown(w).length).toBe(1)
  })
})

describe('session.end pauses the running quiz', () => {
  for (const reason of ['prompt_input_exit', 'clear', 'resume', 'logout', 'other'] as const) {
    test(`reason ${reason}: the pause is on disk when the hook returns, and the end step ran once, unchanged`, async ($, on) => {
      const w = world(on, [])
      await startLive($, w, quizOf({ held: DRAFT }))

      const ended = await $.session.end({ ...END, reason })

      expect(ended).toEqual({ sessionId: SESSION })
      expect(w.endRuns()).toBe(1)
      expect(activeOf(w).quiz).toEqual(quizOf({ held: DRAFT, isPaused: true, pausedAt: PAUSED_AT }))
    })
  }

  test('the pause is written after the end step, not before it', async ($, on) => {
    const w = world(on, [])
    await startLive($, w)
    const mark = w.order.length

    await $.session.end(END)

    expect(w.order.slice(mark)[0]).toBe('end')
    expect(activeWrites(w)).toEqual([ACTIVE_TMP, ACTIVE])
  })

  test('with no running quiz, session end touches no file', async ($, on) => {
    const w = world(on, [])
    seedQuiz(w, quizOf({ sessionId: 'another-session' }))
    await $.session.start(START)
    await w.settle()
    const mark = w.order.length

    await $.session.end(END)

    expect(w.order.slice(mark)).toEqual(['end'])
  })

  test('a quiz a prompt already paused is not written again at session end', async ($, on) => {
    const w = world(on, [])
    await startLive($, w)
    await $.prompt.submit(prompt('fix the login bug'))
    await w.settle()

    await $.session.end(END)

    expect(activeOf(w).seq).toBe(2)
  })

  test('the file system failing: the session still ends, once, with nothing thrown', async ($, on) => {
    const w = world(on, [])
    await startLive($, w)
    w.breakFs()

    const ended = await $.session.end(END)

    expect(ended).toEqual({ sessionId: SESSION })
    expect(w.endRuns()).toBe(1)
    expect(shown(w).every(log => log.text.startsWith('after-build-quiz: could not read active.json ('))).toBe(true)
    expect(shown(w).length <= 1).toBe(true)
  })
})

describe('session.start: resume after a restart', () => {
  test('a quiz paused before the restart shows as paused; nothing is written', async ($, on) => {
    const w = world(on, [])
    await seedPending(w, 1)
    seedQuiz(w, quizOf({ isPaused: true, pausedAt: OLD }))

    await $.session.start(START)

    expect(w.statuses).toEqual([PAUSED])
    expect(activeWrites(w)).toEqual([])
  })

  test('a quiz left running by another session loads as paused, without a write', async ($, on) => {
    const w = world(on, [])
    await seedPending(w, 1)
    seedQuiz(w, quizOf({ sessionId: 'another-session' }))

    await $.session.start(START)
    await w.settle()

    expect(w.statuses.at(-1)).toBe(PAUSED)
    expect(w.fs.store.get(ACTIVE)).toBe(fileText(quizOf({ sessionId: 'another-session' })))
    expect(activeWrites(w)).toEqual([])
  })

  test('with more than one commit pending, the paused status carries the count', async ($, on) => {
    const w = world(on, [])
    await seedPending(w, 3)
    seedQuiz(w, quizOf({ isPaused: true, pausedAt: OLD }))

    await $.session.start(START)

    expect(w.statuses).toEqual([`${PAUSED} · 3 pending`])
  })

  test("this session's own quiz left unpaused (no session end ran) loads as running; the next prompt pauses it", async ($, on) => {
    const w = world(on, [])
    await seedPending(w, 1)
    await startLive($, w)
    expect(w.statuses.at(-1)).toBe('1 quiz pending')

    await $.prompt.submit(prompt('where was I?'))
    await w.settle()

    expect(w.statuses.at(-1)).toBe(PAUSED)
  })

  test('the newer .tmp copy is the one read at start', async ($, on) => {
    const w = world(on, [])
    seedQuiz(w, quizOf(), 1)
    w.fs.store.set(ACTIVE_TMP, fileText(quizOf({ isPaused: true, pausedAt: OLD }), 2))

    await $.session.start(START)

    expect(w.statuses).toEqual([PAUSED])
  })

  test('the paused status survives a commit made later in the session, with the new count', async ($, on) => {
    const repo = makeRepo('C:/work/foo')
    const base = commit(repo, { committedAt: OLD })
    const w = world(on, [repo], { onTool: () => { commit(repo) } })
    await saveQueue(w.fs.io, DATA, {
      ...emptyQueue(),
      pending: [pendingEntry(HASH)],
      lastSeen: { 'C:/work/foo::main': base.hash },
    })
    seedQuiz(w, quizOf({ isPaused: true, pausedAt: OLD }))
    await $.session.start(START)
    await w.settle()

    await $.tool.call({ tool: 'Bash', command: 'git commit -m "Add a"' })
    await w.settle()

    expect(w.statuses.at(-1)).toBe(`${PAUSED} · 2 pending`)
  })
})

describe('corrupt pause state', () => {
  test('corrupt at session start: one notice, no quiz, the pending count shows, active.json is not touched', async ($, on) => {
    const w = world(on, [])
    await seedPending(w, 1)
    w.fs.store.set(ACTIVE, '{ broken')

    await $.session.start(START)
    await w.settle()
    await $.prompt.submit(prompt('fix the login bug'))
    await w.settle()

    expect(shown(w).map(log => log.text)).toEqual(['after-build-quiz: active.json is corrupt; it will be copied aside at the next /quiz'])
    expect(w.statuses.at(-1)).toBe('1 quiz pending')
    expect(w.fs.store.get(ACTIVE)).toBe('{ broken')
    expect(activeWrites(w)).toEqual([])
  })

  test('corrupt when the pause is written: copied aside, exactly one notice across two prompts, nothing thrown', async ($, on) => {
    const w = world(on, [])
    await seedPending(w, 1)
    await startLive($, w)

    w.fs.store.set(ACTIVE, '{ broken')
    const first = await $.prompt.submit(prompt('one'))
    await w.settle()
    w.fs.store.set(ACTIVE, '{ broken again')
    const second = await $.prompt.submit(prompt('two'))
    await w.settle()

    expect([first, second]).toEqual([{ text: 'one' }, { text: 'two' }])
    expect(shown(w).length).toBe(1)
    expect(shown(w)[0]!.text).toContain('active.json was corrupt; saved it as active.corrupt-')
    expect([...w.fs.store.keys()].filter(path => path.includes('active.corrupt-')).length).toBe(1)
    expect(w.statuses.at(-1)).toBe('1 quiz pending')
  })
})

describe('no leak through pause (SPEC 8)', () => {
  for (const [name, quiz] of [
    ['a running quiz', quizOf()],
    ['a held draft', quizOf({ held: DRAFT })],
    ['an unsent answer', quizOf({ held: UNSENT, attempt: { id: 'attempt-7', date: '2026-10-10T08:29:00.000Z' } })],
  ] as const) {
    test(`${name}: no question, key point or answer reaches a prompt result, the status line or any log`, async ($, on) => {
      const w = world(on, [])
      await seedPending(w, 2)
      await startLive($, w, quiz)

      const results = [
        await $.prompt.submit(prompt('fix the login bug')),
        await $.prompt.submit(prompt('/quiz the delay doubles.')),
      ]
      await w.settle()
      results.push(await $.prompt.submit(prompt('and now?', { kind: 'bridge' })))
      const ended = await $.session.end(END)
      await w.settle()

      expect(activeOf(w).quiz!.isPaused).toBe(true)
      const out = JSON.stringify({ results, ended, statuses: w.statuses, logs: w.logs, prompts: w.prompts })
      expect(out).not.toContain(CANARY)
      for (const result of results) expect(Object.keys(result)).toEqual(['text'])
    })
  }

  test('corrupt state holding private text: the notice and the debug log never quote it', async ($, on) => {
    const w = world(on, [])
    await startLive($, w)
    w.fs.store.set(ACTIVE, `{"version":1,"seq":5,"quiz":{"held":{"kind":"draft","text":"${CANARY}-DRAFT cut off he`)

    await $.prompt.submit(prompt('fix the login bug'))
    await w.settle()
    await $.session.end(END)

    expect(shown(w).length).toBe(1)
    expect(JSON.stringify({ statuses: w.statuses, logs: w.logs })).not.toContain(CANARY)
  })
})
