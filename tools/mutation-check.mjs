/**
 * Mutation check for `tool-surface`: prove that filtering the reserved transport
 * name is what keeps the mask alive, and not the retry.
 *
 * `lib/index.js` filters `run_code` out of the deny list before calling
 * `restrict()`. The claim worth checking is that this matters — that if the name
 * were left in, `restrict()` would refuse the whole filter and the mask would be
 * lost. This compiles a mutant that leaves the name in and measures it, so the
 * statement in the source is measured rather than assumed.
 *
 * The mutant keeps the trailing `deny.delete(RESERVED_TRANSPORT)`, so it models
 * "the name reached the set and only a late cleanup removed it" — the exact
 * ordering question. The retry alone cannot save that case: it drops only the
 * caller-named `alsoDeny` entries, so a computed `run_code` survives into the
 * retry too.
 *
 *   node presets/local-lite/tools/mutation-check.mjs
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', 'lib', 'index.js')
const mutant = join(here, '.mutant-tool-surface.mjs')

const original = readFileSync(source, 'utf8')
// Remove BOTH guards, so the reserved name survives into the deny set:
//   1. the loop-level skip
//   2. the trailing cleanup delete
const LOOP_SKIP = '    if (toolName === RESERVED_TRANSPORT) continue\n'
const CLEANUP = '  deny.delete(RESERVED_TRANSPORT)\n'
for (const target of [LOOP_SKIP, CLEANUP]) {
  if (!original.includes(target)) throw new Error(`mutation target not found: ${JSON.stringify(target)}`)
}
writeFileSync(mutant, original.replace(LOOP_SKIP, '').replace(CLEANUP, ''))

const GLOBAL = [
  'read', 'write', 'edit', 'read_image', 'glob', 'grep',
  'web_search', 'web_fetch', 'pwsh', 'job_output', 'job_list', 'job_kill',
  'ssh_list', 'ssh_exec', 'ssh_upload', 'ssh_download', 'ssh_tunnel', 'ssh_cluster',
  'load_workspace_dependencies',
  'run_code',
]

/**
 * Run one plugin module against a registry that refuses `run_code` exactly as
 * the real one does, and report whether the mask survived.
 * @param specifier - module URL of the plugin to exercise.
 */
async function probe(specifier) {
  const { apply } = await import(specifier)
  const accepted = []
  const warnings = []
  const registry = {
    schemas: () => GLOBAL.map((toolName) => ({ name: toolName })),
    restrict(filter) {
      const named = [...(filter.allow ?? []), ...(filter.deny ?? [])]
      if (named.includes('run_code')) {
        throw new Error('cannot name reserved PTC mode presentation transport "run_code"')
      }
      accepted.push(filter)
      return () => {}
    },
  }
  apply({ tools: registry, logger: { warn: (message) => warnings.push(message) } }, {})
  const masked = accepted.length > 0 && (accepted.at(-1).deny ?? []).includes('ssh_cluster')
  return { accepted: accepted.length, warnings: warnings.length, masked }
}

const healthy = await probe(`file:///${source.replaceAll('\\', '/')}`)
const mutated = await probe(`file:///${mutant.replaceAll('\\', '/')}`)
rmSync(mutant, { force: true })

const show = (label, result) =>
  console.log(`  ${label.padEnd(9)} accepted=${result.accepted} warnings=${result.warnings} masked-ssh=${result.masked}`)

console.log('with run_code present in the global view:')
show('original', healthy)
show('mutant', mutated)

const failures = []
// The shipped code must mask despite run_code being in the view.
if (!healthy.masked) failures.push('the original lost the mask when run_code is in the view')
// Leaving the reserved name in must LOSE the mask — otherwise filtering it is
// pointless and the source comment claiming it matters would be wrong.
if (mutated.masked) failures.push('the mutant still masked with run_code in the deny list, so filtering it is not load-bearing')

console.log('')
if (failures.length > 0) {
  console.error('MISMATCH:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('OK: leaving the reserved name in loses the mask, so filtering it is load-bearing.')
