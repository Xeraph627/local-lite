/**
 * Install the reviewed preset into the DSH preset LIBRARY, exactly as the market
 * build would ship it: `preset.yml`, `agent.cordis.yml`, and the one code file
 * the composition names. The market build emits `listFiles(dir)` of the catalog
 * directory, so the library copy carries no development tooling.
 *
 * This is the install path the preset center reads: `readPresetDefinition`
 * absolutizes the relative row to a `file://` URL and declares the result to
 * `ctx.agentPresets`. Running it here is what makes a real-host declaration
 * observable without the Workshop.
 *
 *   node install-to-library.mjs [--from <catalog-dir>] [--remove]
 *
 * The catalog directory is found in this order: `--from`, `$DSH_LOCAL_LITE_CATALOG`,
 * then the usual checkouts, then the current directory.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The library directory under the DSH home: the market install target. */
const LIBRARY_DIR = 'agent-presets'
/** Files that make a directory the preset, plus the code file it names. */
const REQUIRED = ['preset.yml', 'agent.cordis.yml', 'tool-surface.mjs']

const args = process.argv.slice(2)
const fromFlag = args.indexOf('--from')
const explicitFrom = fromFlag === -1 ? undefined : args[fromFlag + 1]

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const library = join(dshHome, LIBRARY_DIR, 'local-lite')

if (args.includes('--remove')) {
  if (!existsSync(library)) {
    console.log(`nothing to remove: ${library} does not exist`)
    process.exit(0)
  }
  rmSync(library, { recursive: true, force: true })
  console.log(`removed: ${library}`)
  process.exit(0)
}

/** Whether a directory holds every file the preset ships. */
const isCatalogDir = (dir) => REQUIRED.every((name) => existsSync(join(dir, name)))

const candidates = [
  explicitFrom,
  process.env.DSH_LOCAL_LITE_CATALOG,
  // The dsh-presets checkout, wherever it was cloned.
  resolve(process.cwd(), '.tmp-dshpresets', 'presets', 'local-lite'),
  resolve(process.cwd(), 'presets', 'local-lite'),
  // This tool's own repo, when run from the submission checkout.
  resolve(import.meta.dirname, '..'),
].filter((dir) => typeof dir === 'string')

const catalogDir = candidates.find((dir) => isCatalogDir(dir))
if (catalogDir === undefined) {
  console.error(`no directory holds all of: ${REQUIRED.join(', ')}`)
  console.error('looked in:')
  for (const dir of candidates) console.error(`  ${dir}`)
  console.error('pass --from <catalog-dir> to name it')
  process.exit(2)
}

mkdirSync(library, { recursive: true })
for (const name of REQUIRED) cpSync(join(catalogDir, name), join(library, name))

console.log(`installed from : ${catalogDir}`)
console.log(`library preset : ${library}`)
for (const name of readdirSync(library).sort()) {
  console.log(`  ${String(statSync(join(library, name)).size).padStart(6)}  ${name}`)
}
console.log('\nnext: restart DSH, enable it in the Presets panel, then run a session.')
