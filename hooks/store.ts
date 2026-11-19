import type { SafeDataDir } from './paths.ts'

// Crash-safe whole-file JSON storage in the data folder, shared by queue.json and active.json. See SPEC
// "Storage". Without rename ($.fs has none) a save writes the whole file to `<name>.json.tmp` first, then
// to `<name>.json`, so at every moment one of them is complete; each save carries a higher `seq`, and a
// load takes the valid copy with the higher one (a tie keeps `<name>.json`).
//
// Nothing here builds a notice: callers word their own. An unreadable file's reason is the file system's
// error, never the file's text (a JSON parse error quotes its input, so it is dropped). Writes only take a
// data folder checked to be outside any repo (SafeDataDir); reading only takes a plain path.

export type StoreIO = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
}

export type StoreFile<T extends { seq: number }> = {
  name: 'queue' | 'active' // <name>.json, <name>.json.tmp, <name>.corrupt-<now>.json
  parse: (value: unknown) => T | undefined // the shape check, normalised; undefined: corrupt
}

// What a read-only look finds. `unreadable`: <name>.json could not be read, so neither copy is used.
export type Peeked<T> =
  | { kind: 'unreadable'; reason: string }
  | { kind: 'found'; value: T }
  | { kind: 'corrupt' }
  | { kind: 'absent' }

// What a load to change the file finds: a corrupt file with no good copy is copied aside first.
export type Loaded<T> =
  | Exclude<Peeked<T>, { kind: 'corrupt' }>
  | { kind: 'setAside'; asideName: string } // copied aside: start fresh, writable
  | { kind: 'asideFailed' } // the copy aside failed: the corrupt file is left as it is, not writable

export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

type FileState<T> =
  | { state: 'absent' }
  | { state: 'unreadable'; reason: string }
  | { state: 'invalid'; text: string }
  | { state: 'valid'; value: T }

const readState = async <T extends { seq: number }>(
  io: StoreIO, path: string, file: StoreFile<T>,
): Promise<FileState<T>> => {
  let text: string
  try {
    if (!(await io.exists(path))) return { state: 'absent' }
    text = await io.read(path)
  } catch (error) {
    return { state: 'unreadable', reason: oneLine(String(error)) }
  }
  try {
    const value = file.parse(JSON.parse(text))
    return value === undefined ? { state: 'invalid', text } : { state: 'valid', value }
  } catch {
    return { state: 'invalid', text } // the parse error quotes the file: dropped, never reported
  }
}

const filesOf = (dataDir: string, name: string) => ({ main: `${dataDir}/${name}.json`, tmp: `${dataDir}/${name}.json.tmp` })

// Both copies are always read, <name>.json first. An unreadable <name>.json is never used or
// overwritten, whatever the `.tmp` copy holds: loading the copy as writable would let the next save
// overwrite a file that could not be read. An unreadable or corrupt `.tmp` is passed over.
const inspect = async <T extends { seq: number }>(
  io: StoreIO, dataDir: string, file: StoreFile<T>,
): Promise<Exclude<Peeked<T>, { kind: 'corrupt' }> | { kind: 'corrupt'; text: string }> => {
  const { main, tmp } = filesOf(dataDir, file.name)
  const mainState = await readState(io, main, file)
  const tmpState = await readState(io, tmp, file)
  if (mainState.state === 'unreadable') return { kind: 'unreadable', reason: mainState.reason }

  const valid = [mainState, tmpState].flatMap(copy => (copy.state === 'valid' ? [copy.value] : []))
  if (valid.length > 0) {
    return { kind: 'found', value: valid.reduce((best, value) => (value.seq > best.seq ? value : best)) }
  }
  if (mainState.state === 'invalid') return { kind: 'corrupt', text: mainState.text }
  return { kind: 'absent' }
}

// Reading only, for the status line: nothing is ever written, not even the copy aside.
export const peekStore = async <T extends { seq: number }>(
  io: StoreIO, dataDir: string, file: StoreFile<T>,
): Promise<Peeked<T>> => {
  const found = await inspect(io, dataDir, file)
  return found.kind === 'corrupt' ? { kind: 'corrupt' } : found
}

// Loading to change the file: a corrupt <name>.json with no good copy is copied aside verbatim as
// <name>.corrupt-<now>.json.
export const loadStore = async <T extends { seq: number }>(
  io: StoreIO, dataDir: SafeDataDir, file: StoreFile<T>, now: string,
): Promise<Loaded<T>> => {
  const found = await inspect(io, dataDir, file)
  if (found.kind !== 'corrupt') return found
  const asideName = `${file.name}.corrupt-${now.replace(/[:.]/g, '-')}.json`
  try {
    await io.write(`${dataDir}/${asideName}`, found.text)
  } catch {
    return { kind: 'asideFailed' }
  }
  return { kind: 'setAside', asideName }
}

// Writes `next` as it is given (raising its seq and checking it are the caller's): `.tmp` first, then
// <name>.json. False when a write fails. The JSON is built before the writes, outside the catch.
export const saveStore = async <T extends { seq: number }>(
  io: StoreIO, dataDir: SafeDataDir, file: StoreFile<T>, next: T,
): Promise<boolean> => {
  const { main, tmp } = filesOf(dataDir, file.name)
  const text = `${JSON.stringify(next, null, 2)}\n`
  try {
    await io.write(tmp, text)
    await io.write(main, text)
    return true
  } catch {
    return false
  }
}
