// Source scan, run with Node (not `claude plugin test`, whose environment has
// no file system):  node tests/integration/safe-data-dir-casts.mjs [folder]
//
// SafeDataDir marks a data folder checked to be outside any repo. The brand is
// an accident guard, not a security boundary: a cast mints one without the
// check. So the only cast allowed is the one inside safeDataDirOf in
// hooks/paths.ts (AGENTS.md). This fails on a cast to it anywhere else under
// hooks/ or tests/. [folder] defaults to this repo; isolated checks pass the export.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
const ALLOWED = 'hooks/paths.ts'
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/
const CAST = new RegExp('\\bas\\s+' + 'SafeDataDir' + '\\b') // built so this file does not match itself

const found = []
let scanned = 0
let allowedCasts = 0
for (const top of ['hooks', 'tests']) {
  for (const name of readdirSync(join(root, top), { recursive: true })) {
    const path = `${top}/${String(name).replaceAll('\\', '/')}`
    if (!SOURCE.test(path)) continue
    scanned++
    readFileSync(join(root, path), 'utf8').split('\n').forEach((line, i) => {
      if (!CAST.test(line)) return
      if (path === ALLOWED) allowedCasts++
      else found.push(`${path}:${i + 1}: ${line.trim()}`)
    })
  }
}

// The one allowed cast must still be found, or the pattern has stopped matching casts at all.
if (allowedCasts !== 1) {
  console.error(`FAIL: expected exactly 1 cast to SafeDataDir in ${ALLOWED} (safeDataDirOf), found ${allowedCasts}`)
  process.exit(1)
}
if (scanned === 0) {
  console.error(`FAIL: no source files under ${relative(process.cwd(), root) || '.'}/hooks or tests`)
  process.exit(1)
}
if (found.length > 0) {
  console.error(`FAIL: cast to SafeDataDir outside ${ALLOWED} (use safeDataDirOf):`)
  for (const line of found) console.error(`  ${line}`)
  process.exit(1)
}
console.log(`ok: ${scanned} source files, no cast to SafeDataDir outside ${ALLOWED}`)
