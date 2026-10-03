/**
 * Harness for the `tool-surface` plugin: import it and run `apply` against a
 * fake registry, so a logic fault is separated from a Host module-resolution
 * fault. A Host reports both as "never started", which says nothing about which
 * it was — that ambiguity is exactly how a relative row name slipped through.
 *
 *   node presets/local-lite/tools/test-tool-surface.mjs
 */
import { apply, inject, name } from '../lib/index.js'

console.log(`plugin: name=${name} inject=[${inject.join(', ')}] apply=${typeof apply}`)
if (typeof apply !== 'function') throw new Error('apply is not a function')

/** Names the fake registry reports in its global view, mirroring the measured session. */
const GLOBAL = [
  'read', 'write', 'edit', 'read_image', 'glob', 'grep',
  'web_search', 'web_fetch', 'pwsh', 'job_output', 'job_list', 'job_kill',
  'ssh_list', 'ssh_exec', 'ssh_upload', 'ssh_download', 'ssh_tunnel', 'ssh_cluster',
  'load_workspace_dependencies',
]

/** A registry double that records the filter and validates it the way the real one does. */
function fakeRegistry(globalNames = GLOBAL) {
  const restricatable = new Set(globalNames)
  const calls = []
  return {
    calls,
    registry: {
      schemas: () => globalNames.map((n) => ({ name: n })),
      restrict(filter) {
        const named = [...(filter.allow ?? []), ...(filter.deny ?? [])]
        if (named.includes('run_code')) throw new Error('reserved transport name')
        const unknown = named.filter((n) => !restricatable.has(n))
        if (unknown.length > 0) throw new Error(`unknown global tool(s) ${unknown.join(', ')}`)
        calls.push(filter)
        return () => {}
      },
    },
  }
}

const warnings = []
const { registry, calls } = fakeRegistry()
apply({ tools: registry, logger: { warn: (m) => warnings.push(m) } }, { keep: [] })

console.log(`\nrestrict() calls: ${calls.length}`)
console.log(`deny (${calls[0]?.deny.length ?? 0}): ${(calls[0]?.deny ?? []).join(', ')}`)
console.log(`warnings: ${warnings.length === 0 ? '(none)' : warnings.join(' | ')}`)

const denied = new Set(calls[0]?.deny ?? [])
const leaked = GLOBAL.filter((n) => !denied.has(n))
console.log(`\ntools still visible after the trim (${leaked.length}): ${leaked.join(', ')}`)

// A name the preset registers itself must never appear in the filter.
const ownLeak = [...(calls[0]?.deny ?? [])].filter((n) => ['read', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch', 'pwsh', 'bash'].includes(n))
if (ownLeak.length > 0) throw new Error(`preset's own tools were denied: ${ownLeak.join(', ')}`)
if (warnings.length > 0) throw new Error('apply warned on a healthy registry')
console.log('\nOK: exactly the non-preset globals are denied.')
