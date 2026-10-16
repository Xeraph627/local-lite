/**
 * Harness for the `tool-surface` plugin: import it and run `apply` against a
 * registry double, so a logic fault is separated from a Host module-resolution
 * fault. A Host reports both as "never started", which says nothing about which
 * it was — that ambiguity is exactly how a relative row name slipped through
 * once already.
 *
 * The double reproduces the real registry's REJECTIONS, not just its happy path,
 * because each of the three cases below is a way the mask can silently become a
 * no-op:
 *
 *   - `run_code` is the reserved PTC transport and `restrict()` refuses it. With
 *     the deployment's `tools` row in `ptc`/`both` mode it IS in the global view,
 *     so an unfiltered deny list throws and nothing gets masked at all.
 *   - an unknown name is refused, and one such name must not cost the whole mask.
 *   - a name the preset registers itself is scope-local and refused.
 *
 *   node presets/local-lite/tools/test-tool-surface.mjs
 */
import { apply, inject, name, RESERVED_TRANSPORT } from '../lib/index.js'

console.log(`plugin: name=${name} inject=[${inject.join(', ')}] apply=${typeof apply}`)
if (typeof apply !== 'function') throw new Error('apply is not a function')
if (RESERVED_TRANSPORT !== 'run_code') throw new Error(`unexpected reserved transport: ${RESERVED_TRANSPORT}`)

/** Names a host with the SSH plugin mounted reports, mirroring the measured session. */
const GLOBAL_WITH_SSH = [
  'read', 'write', 'edit', 'read_image', 'glob', 'grep',
  'web_search', 'web_fetch', 'pwsh', 'job_output', 'job_list', 'job_kill',
  'ssh_list', 'ssh_exec', 'ssh_upload', 'ssh_download', 'ssh_tunnel', 'ssh_cluster',
  'load_workspace_dependencies',
]

/** The plain-harness surface: the preset's own tools plus what it cannot declare. */
const GLOBAL_PLAIN = [
  'read', 'write', 'edit', 'read_image', 'glob', 'grep',
  'web_search', 'web_fetch', 'pwsh', 'job_output', 'job_list', 'job_kill',
  'load_workspace_dependencies',
]

/** Names the preset registers in its own scope; the registry refuses to mask them. */
const SCOPE_LOCAL = new Set(['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'web_search', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill'])

/**
 * A registry double faithful to the contract in `@deepseek-ai/dsh-tools`:
 * `schemas()` is the scope-less global view, and `restrict()` throws on the
 * reserved transport name, on unknown global tools, and on scope-local names.
 * @param globalNames - names the global view reports.
 * @param options - `refuse` names to treat as simultaneously unknown and scope-local.
 */
function fakeRegistry(globalNames = GLOBAL_WITH_SSH, options = {}) {
  const calls = []
  const rejections = []
  const refused = new Set(options.refuse ?? [])
  return {
    calls,
    rejections,
    registry: {
      schemas: () => globalNames.map((toolName) => ({ name: toolName })),
      restrict(filter) {
        const named = [...(filter.allow ?? []), ...(filter.deny ?? [])]
        const refuse = (reason) => {
          rejections.push(reason)
          throw new Error(reason)
        }
        if (named.includes(RESERVED_TRANSPORT)) {
          refuse(`cannot name reserved PTC mode presentation transport "${RESERVED_TRANSPORT}"`)
        }
        const local = named.filter((toolName) => SCOPE_LOCAL.has(toolName))
        if (local.length > 0) refuse(`names scope-local tool(s) ${local.join(', ')}`)
        const unknown = named.filter((toolName) => !globalNames.includes(toolName) || refused.has(toolName))
        if (unknown.length > 0) refuse(`names unknown global tool(s) ${unknown.join(', ')}`)
        calls.push(filter)
        return () => {}
      },
    },
  }
}

/** Run `apply` and capture the warnings it logged. */
function run(globalNames, config, options) {
  const warnings = []
  const { registry, calls, rejections } = fakeRegistry(globalNames, options)
  apply({ tools: registry, logger: { warn: (message) => warnings.push(message) } }, config)
  return { calls, rejections, warnings }
}

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    failures.push(label)
  }
}

// 1. The measured deployment: SSH tools installed, so six controls must go.
console.log('\n[1] host with the SSH plugin mounted')
{
  const { calls, warnings } = run(GLOBAL_WITH_SSH, { keep: [] })
  const deny = calls[0]?.deny ?? []
  const denied = new Set(deny)
  const leaked = GLOBAL_WITH_SSH.filter((toolName) => !denied.has(toolName))
  console.log(`      deny (${deny.length}): ${deny.join(', ')}`)
  console.log(`      still visible (${leaked.length}): ${leaked.join(', ')}`)
  check('exactly one restrict() call', calls.length === 1, `got ${calls.length}`)
  check('no warnings on a healthy registry', warnings.length === 0, warnings.join(' | '))
  check('every ssh_* control is denied', GLOBAL_WITH_SSH.filter((n) => n.startsWith('ssh_')).every((n) => denied.has(n)))
  check('load_workspace_dependencies is denied', denied.has('load_workspace_dependencies'))
  check('no tool the preset registers is denied', deny.every((toolName) => !SCOPE_LOCAL.has(toolName)))
  check(
    'web_fetch IS denied, because this preset does not register it',
    denied.has('web_fetch'),
    'a host-global web_fetch must be masked or the fetch:false posture is inverted',
  )
  check('nothing but the non-preset globals is denied', deny.length === 8, `got ${deny.length}`)
}

// 2. The PTC regression: run_code is in the view. It must never reach the
//    filter, and even if it did the retry has to recover the mask.
console.log('\n[2] deployment whose tools row presents ptc/both (run_code in the view)')
{
  const withTransport = [...GLOBAL_WITH_SSH, RESERVED_TRANSPORT]
  const { calls, rejections, warnings } = run(withTransport, { keep: [] })
  console.log(`      restrict() rejections: ${rejections.length}; accepted calls: ${calls.length}`)
  check(`no rejection naming ${RESERVED_TRANSPORT}`, !rejections.some((r) => r.includes(RESERVED_TRANSPORT)), rejections.join(' | '))
  check('the filter is accepted on the first attempt', calls.length === 1 && rejections.length === 0)
  check(`${RESERVED_TRANSPORT} is not named in the filter`, !(calls[0]?.deny ?? []).includes(RESERVED_TRANSPORT))
  check('the real tools are still masked', (calls[0]?.deny ?? []).includes('ssh_cluster'))
  check('no failure warning', warnings.length === 0, warnings.join(' | '))
}

// 2b. The retry IS load-bearing: if a reserved name reaches the filter anyway,
//     the mask must survive the rejection. Verified by mutation in
//     tools/mutation-check.mjs; asserted here so a refactor cannot drop it.
console.log('\n[2b] a reserved name forced into the filter (recovery path)')
{
  const withTransport = [...GLOBAL_WITH_SSH, RESERVED_TRANSPORT]
  // A registry that rejects run_code but, unlike the real one, also reports it
  // through a path the filter cannot see: model it by refusing the first call.
  const calls = []
  const rejections = []
  let first = true
  const registry = {
    schemas: () => withTransport.map((toolName) => ({ name: toolName })),
    restrict(filter) {
      if (first) {
        first = false
        rejections.push('forced rejection')
        throw new Error('forced rejection')
      }
      calls.push(filter)
      return () => {}
    },
  }
  const warnings = []
  apply({ tools: registry, logger: { warn: (message) => warnings.push(message) } }, {})
  check('the retry recovered the mask', calls.length === 1, `${calls.length} accepted call(s)`)
  check('the recovered mask still removes the inherited tools', (calls[0]?.deny ?? []).includes('ssh_cluster'))
  check('the rejection was logged, not swallowed', warnings.length === 1, `${warnings.length} warning(s)`)
}

// 3. A name the registry refuses must cost that name, not the whole mask.
console.log('\n[3] a deny entry the registry rejects (unknown global name)')
{
  const { calls, warnings } = run(GLOBAL_WITH_SSH, { alsoDeny: ['not_a_real_tool'] })
  check('a narrowed retry still masked the real tools', calls.length === 1, `got ${calls.length} call(s)`)
  check('the rejected name is not in the retry', !(calls[0]?.deny ?? []).includes('not_a_real_tool'))
  check('the rejection was logged', warnings.length === 1, `${warnings.length} warning(s)`)
}

// 4. Plain harness: the preset's cost is what it declares, and it must not mask its own.
console.log('\n[4] plain harness (11 tools on the wire)')
{
  const { calls, warnings } = run(GLOBAL_PLAIN, { keep: [] })
  const deny = calls[0]?.deny ?? []
  console.log(`      deny (${deny.length}): ${deny.join(', ') || '(none)'}`)
  check(
    'only the inherited globals are denied (load_workspace_dependencies, web_fetch)',
    deny.length === 2 && deny.includes('load_workspace_dependencies') && deny.includes('web_fetch'),
    deny.join(', '),
  )
  check('no warnings', warnings.length === 0, warnings.join(' | '))
}

// 5. `keep` is the escape hatch and must win over the mask.
console.log('\n[5] keep an inherited global tool')
{
  const { calls } = run(GLOBAL_WITH_SSH, { keep: ['ssh_exec'] })
  check('the kept name is not denied', !(calls[0]?.deny ?? []).includes('ssh_exec'))
  check('the other inherited names still are', (calls[0]?.deny ?? []).includes('ssh_cluster'))
}

// 6. An unreadable global view must not produce a guessed mask.
console.log('\n[6] global view unreadable')
{
  const warnings = []
  let restrictCalls = 0
  const registry = {
    schemas: () => {
      throw new Error('registry unavailable')
    },
    restrict: () => {
      restrictCalls += 1
    },
  }
  apply({ tools: registry, logger: { warn: (message) => warnings.push(message) } }, {})
  check('restrict() is not called on a guess', restrictCalls === 0, `${restrictCalls} call(s)`)
  check('the failure was logged', warnings.length === 1, `${warnings.length} warning(s)`)
}

console.log('')
if (failures.length > 0) {
  console.error(`FAILED (${failures.length}): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('OK: mask computed, narrowed and kept correctly across all six cases.')
