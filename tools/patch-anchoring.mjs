/**
 * Mirror the Host's row-name anchoring, so a bundle patch can be checked for
 * resolvability without starting DSH.
 *
 * The Host's `anchorInsertedPluginNames` walks `insert` rows and the children of
 * `group: true` rows, converting any absolute or `./`-relative `name` into a
 * `file://` URL beside the patch. It does NOT descend into a preset
 * declaration's `config.plugins`, which is why a relative name there fails at
 * mount with "<id>: never started". This module reimplements that walk (plus
 * the preset-declaration descent the Host lacks) so the checker can see exactly
 * which names would reach the Loader as unresolved strings.
 *
 * @module patch-anchoring
 */
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Whether a row name is meant as a path rather than a package specifier. */
export function isPathName(name) {
  return typeof name === 'string' && (isAbsolute(name) || name.startsWith('./') || name.startsWith('../'))
}

/**
 * Convert one row name the way the Host would, leaving specifiers alone.
 * @param name - the row's raw `name`.
 * @param base - directory the patch file lives in.
 * @returns the name as the Loader would receive it.
 */
export function anchorName(name, base) {
  if (!isPathName(name)) return name
  return pathToFileURL(resolve(base, name)).href
}

/**
 * Walk a row list, anchoring names and descending into both Cordis groups and
 * preset declarations' `config.plugins`.
 * @param rows - raw row list.
 * @param base - directory the patch file lives in.
 * @param visit - called as `(row, anchoredName, depth)` for every row seen.
 * @param depth - current nesting depth, for callers that report a tree.
 */
export function walkRows(rows, base, visit, depth = 0) {
  for (const row of rows ?? []) {
    if (row === null || typeof row !== 'object') continue
    visit(row, anchorName(row.name, base), depth)
    if (row.group === true && Array.isArray(row.config)) walkRows(row.config, base, visit, depth + 1)
    if (Array.isArray(row.config?.plugins)) walkRows(row.config.plugins, base, visit, depth + 1)
  }
}

/** Whether an anchored `file://` name points at a file that exists. */
export function anchoredPathExists(anchored) {
  if (typeof anchored !== 'string' || !anchored.startsWith('file:')) return false
  try {
    return statSync(fileURLToPath(anchored)).isFile()
  } catch {
    return false
  }
}
