/**
 * tool-surface — free the preset's context window from every global tool the
 * preset does not declare.
 *
 * This copy is the package form: `package.json` exposes it via `exports`, and
 * `cordis.patch.yml` names the bundle's own package as the row name. It imports
 * nothing either way, so the package and the preset-directory copy of this file
 * are behaviourally identical.
 *
 * `ctx.tools.restrict()` masks a scope's GLOBAL tools while leaving that scope's
 * own registrations visible, which is the seam this preset needs: the mounting
 * context is the preset's standing scope, so one `deny` computed here covers
 * every agent joined under it.
 *
 * The deny list is COMPUTED, never hardcoded. A hardcoded list of globally
 * mounted tools (SSH controls, workspace dependency paths, and whatever the
 * deployment adds next) would be stale the moment the profile changes, and
 * `restrict()` THROWS on an unknown name — so a stale entry would break the
 * preset instead of quietly costing tokens. Instead:
 *
 *   deny = { names in the global view }
 *        - { names this preset registers itself }   // `ownTools` below
 *        - { reserved transport names }             // `run_code`
 *        - { keep }                                 // config escape hatch
 *        + { alsoDeny }                             // config escape hatch
 *
 * `run_code` MUST be filtered out of the deny list: with the deployment's `tools`
 * row in `ptc` or `both` mode the global view carries that reserved PTC
 * transport name, and `restrict()` refuses it. Measured with
 * `tools/mutation-check.mjs`: leaving the name in loses the ENTIRE mask, and the
 * retry cannot recover it — the retry drops only caller-named `alsoDeny` entries,
 * so a computed `run_code` survives into it as well.
 *
 * The filter appears twice on purpose (the loop skip and the trailing
 * `deny.delete`), and either alone is sufficient — the mutation check removes
 * both to make the failure observable. Two guards for one condition, because a
 * silently inert mask is invisible to both the model and the user: the only
 * symptom is a slightly larger request, which nothing reports.
 *
 * Every remaining failure path narrows rather than gives up: an unknown name
 * costs the caller-named `alsoDeny` entries (the call is retried without them),
 * and only a registry that cannot be read at all leaves the surface untouched. A
 * preset whose surface could not be trimmed still composes — it just pays the
 * tokens.
 *
 * Measured on the author's deployment: the preset's own standing cost is about
 * 2,004 tokens per request, and the inherited surface it masks — six `ssh_*`
 * controls plus `load_workspace_dependencies` — was about 1,151 of those. That
 * second number is profile-dependent by nature, since the row can only remove
 * tools the host mounted; on a plain harness the wire carries 11 tools instead
 * of 13.
 *
 * @module @Xeraph627/dsh-local-lite-preset
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-surface'

/** The registry this row masks. */
export const inject = ['tools']

/**
 * The reserved PTC transport name. `restrict()` rejects it because it is not an
 * end-capability tool: masking it would have to be expressed as a presentation
 * change, not a restriction.
 */
export const RESERVED_TRANSPORT = 'run_code'

/**
 * Trim the preset's visible tool surface to the tools it declares.
 * @param ctx - the preset's mounting context, which owns the standing scope.
 * @param config - `keep` retains names past the preset's own; `alsoDeny` removes names regardless.
 */
export function apply(ctx, config) {
  const keep = new Set(config?.keep ?? [])
  const alsoDeny = new Set(config?.alsoDeny ?? [])

  const globalNames = readGlobalToolNames(ctx)
  if (globalNames === undefined) return

  const deny = new Set()
  for (const toolName of globalNames) {
    if (ownTools.has(toolName) || keep.has(toolName)) continue
    if (toolName === RESERVED_TRANSPORT) continue
    deny.add(toolName)
  }
  for (const toolName of alsoDeny) deny.add(toolName)
  for (const toolName of ownTools) deny.delete(toolName)
  deny.delete(RESERVED_TRANSPORT)

  if (deny.size === 0) return

  try {
    // The returned disposer is owned by the plugin's effect scope; the loader
    // releases the restriction when this preset unmounts.
    ctx.tools.restrict({ deny: [...deny].sort() })
    return
  } catch (error) {
    ctx.logger?.warn?.(`tool-surface: restrict() rejected the full deny list (${error.message})`)
  }

  // The registry rejected the filter. Retry once without the entries the caller
  // named explicitly, so one bad `alsoDeny` cannot cost the whole mask. This does
  // NOT rescue a computed reserved name: the retry keeps everything computed,
  // which is why the `run_code` filter above is load-bearing rather than a
  // belt-and-braces extra.
  const narrowed = [...deny].filter((toolName) => !alsoDeny.has(toolName)).sort()
  if (narrowed.length === 0) return
  try {
    ctx.tools.restrict({ deny: narrowed })
  } catch (error) {
    ctx.logger?.warn?.(
      `tool-surface: could not trim the global tool view (${error.message}); the preset composed with its full inherited surface`,
    )
  }
}

/**
 * Every tool name the preset registers for itself, on either platform. Listing
 * both platform shells keeps the set correct without reading the current
 * platform: a name that is not registered cannot appear in the global view, so
 * an extra entry is inert while a missing one would be masked.
 */
const ownTools = new Set([
  'read',
  'write',
  'edit',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'bash',
  'pwsh',
  'job_output',
  'job_list',
  'job_kill',
])

/**
 * The registry's global tool names, or undefined when the view cannot be read —
 * in which case the caller trims nothing rather than masking on a guess.
 * @param ctx - the preset's mounting context.
 */
function readGlobalToolNames(ctx) {
  try {
    return ctx.tools.schemas().map((schema) => schema.name)
  } catch (error) {
    ctx.logger?.warn?.(`tool-surface: could not read the global tool view (${error.message})`)
    return undefined
  }
}
