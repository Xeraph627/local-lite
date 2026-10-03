/**
 * tool-surface — free the preset's context window from every global tool the
 * preset does not declare.
 *
 * `ctx.tools.restrict()` masks a scope's GLOBAL tools while leaving that scope's
 * own registrations visible, which is the seam this preset needs: the mounting
 * context is the preset's standing scope, so one `deny` computed here covers
 * every agent joined under it.
 *
 * WHY THIS SHIPS INSIDE THE BUNDLE PACKAGE, not beside the patch and not as a
 * sibling dependency. A row name that is a path never resolves here: the Host's
 * patch parser anchors `insert` rows and `group: true` children only, so inside
 * a preset declaration's `config.plugins` a `.mjs` path reaches the Loader
 * unresolvable — relative stays a relative string, and absolute stays a bare
 * filesystem path rather than a `file://` URL. The row's fiber is then never
 * created and the registry's audit fails the ENTIRE preset with "never
 * started". A bare specifier is the only thing that works, and it must be THIS
 * package's own name: a `link:`/`file:` dependency of a bundle is not installed
 * transitively, because the profile symlinks the bundle folder and never
 * installs the bundle's own dependencies — a nested package would be missing on
 * every other machine.
 *
 * The deny list is COMPUTED, never hardcoded. A hardcoded list of globally
 * mounted tools (SSH controls, workspace dependency paths, and whatever the
 * deployment adds next) would be stale the moment the profile changes, and
 * `restrict()` THROWS on an unknown name — so a stale entry would break the
 * preset instead of quietly costing tokens. Instead:
 *
 *   deny = { names in the global view }
 *        - { names this preset registers itself }   // `ownTools` below
 *        - { keep }                                 // config escape hatch
 *        + { alsoDeny }                             // config escape hatch
 *
 * The global view is read with no scope argument, so it contains global
 * registrations only — never this preset's own tools. `ownTools` is subtracted
 * anyway, because `restrict()` also rejects a name that is scope-local, and
 * every failure path logs and returns: a preset whose surface could not be
 * trimmed still composes, it just pays the tokens.
 *
 * Measured on this deployment before the trim: 19 tools / ~2,969 schema tokens,
 * of which the six `ssh_*` controls and `load_workspace_dependencies` are not
 * part of this preset and cost ~1,249 of them.
 *
 * @module @Xeraph627/dsh-local-lite-preset
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-surface'

/** The registry this row masks. */
export const inject = ['tools']

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
    deny.add(toolName)
  }
  for (const toolName of alsoDeny) deny.add(toolName)
  for (const toolName of ownTools) deny.delete(toolName)

  if (deny.size === 0) return

  try {
    // The returned disposer is owned by the plugin's effect scope; the loader
    // releases the restriction when this preset unmounts.
    ctx.tools.restrict({ deny: [...deny].sort() })
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
