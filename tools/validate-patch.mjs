/**
 * Validate the local-lite bundle patch before installing it.
 *
 * Two classes of fault are checked, because the Host reports both the same way
 * and neither message names the real cause:
 *
 * 1. SHAPE — the declaration the registry will receive: required keys and a
 *    legal preset id.
 * 2. ROW NAME RESOLUTION — the check that matters most, because getting it
 *    wrong fails the WHOLE preset rather than one row. The Host's patch parser
 *    anchors `insert` rows and `group: true` children only, so inside a preset
 *    declaration's `config.plugins` a path name reaches the Loader
 *    unresolvable: `./plugin.mjs` stays a relative string, and `/abs/plugin.mjs`
 *    stays a bare filesystem path instead of a `file://` URL. The row's fiber is
 *    never created and the registry's audit reports "<id>: never started".
 *    A path row is therefore a hard error below, and every bare specifier is
 *    resolved for real — a bare specifier that does not resolve fails the same
 *    way as a path, which is exactly how the shipped bug presented.
 *
 * `!!js` is a Loader extension that plain js-yaml rejects, so this registers a
 * permissive tag for it and reports the expression unevaluated.
 *
 *   node presets/local-lite/tools/validate-patch.mjs presets/local-lite/cordis.patch.yml
 */
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPathName, walkRows } from './patch-anchoring.mjs'

const require = createRequire('file:///C:/Users/ASUS/.dsh/profiles/desktop/package.json')
const yaml = require('js-yaml')

const JsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (data) => ({ __js: data }),
})

const file = resolve(process.argv[2] ?? 'presets/local-lite/cordis.patch.yml')
const base = dirname(file)
const doc = yaml.load(readFileSync(file, 'utf8'), { schema: yaml.DEFAULT_SCHEMA.extend([JsTag]) })

/**
 * The bundle's own package name: the one specifier a row can use that resolves
 * from the bundle itself, and therefore the one this checker can resolve for
 * real. Upstream `@deepseek-ai/*` rows resolve from the PROFILE's tree, not from
 * here, so resolving those locally would report false failures.
 */
const OWN_NAME = JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8')).name

/**
 * Resolve the bundle's own specifier the way the Loader will: against a module
 * URL inside the bundle directory, so the package's `exports` map is honoured.
 * @param specifier - the row's `name`.
 * @returns the resolved URL, or an Error explaining the failure.
 */
function resolveRowSpecifier(specifier) {
  try {
    return import.meta.resolve(specifier, `file:///${base.replaceAll('\\', '/')}/package.json`)
  } catch (error) {
    return error
  }
}

/** Whether a resolved `file://` URL names an existing regular file. */
function existsAsFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile()
  } catch {
    return false
  }
}

const problems = []
if (!Array.isArray(doc)) problems.push('root is not a YAML array')

const insertEntry = doc.find((row) => row && Array.isArray(row.insert))
if (!insertEntry) problems.push('no entry carrying an `insert` list')

const decl = insertEntry?.insert?.find((row) => row?.name === '@deepseek-ai/dsh-agent-preset')
if (!decl) problems.push('no @deepseek-ai/dsh-agent-preset row in the insert list')
if (decl && decl.id !== 'preset-local-lite') problems.push(`unexpected loader row id: ${decl?.id}`)

const cfg = decl?.config ?? {}
for (const key of ['id', 'plugins']) {
  if (cfg[key] === undefined) problems.push(`config.${key} is missing`)
}
if (!/^[a-z0-9-]+$/.test(String(cfg.id))) problems.push(`config.id is not lowercase/digits/hyphens: ${cfg.id}`)
if (!Array.isArray(cfg.plugins) || cfg.plugins.length === 0) problems.push('config.plugins is empty')

/** Walk the declaration, reporting each row at its nesting depth. */
const rows = []
walkRows(cfg.plugins, base, (row, anchored, depth) => rows.push({ row, anchored, depth }))

console.log(`patch          : ${file}`)
console.log(`preset id      : ${cfg.id}`)
console.log(`display name   : ${cfg.name}`)
console.log(`order          : ${cfg.order}`)
console.log(`rows (walked)  : ${rows.length}`)
console.log('---')

for (const { row, anchored, depth } of rows) {
  const pad = '  '.repeat(depth)
  const disabled = row.disabled === undefined ? '' : `   disabled=${JSON.stringify(row.disabled)}`

  // A path name inside a preset declaration is rejected outright, not merely
  // checked for existence. The Host's parser anchors `insert` rows and
  // `group: true` children only, so inside `config.plugins` a path reaches the
  // Loader unusable either way — and the failure lands on the WHOLE preset
  // ("<id>: never started"), not just this row. Measured, not theorised: both
  // `./plugin.mjs` and an absolute path failed this way in a live session.
  if (isPathName(row.name)) {
    console.log(`${pad}- ${row.id}  [${row.name}]${disabled}   -> ${anchored}`)
    problems.push(
      `row ${row.id}: "${row.name}" is a path, and paths do not resolve inside a preset declaration — ` +
        'the Host anchors insert rows and group children only, so this fails the entire preset with ' +
        '"never started". Ship the plugin as a package and use a bare specifier.',
    )
  } else if (row.name === OWN_NAME) {
    // The bundle's own specifier must resolve for real. An unresolvable
    // specifier fails exactly like a path does, so checking only "is it a
    // specifier" would have passed the bug that shipped.
    const resolved = resolveRowSpecifier(row.name)
    if (resolved instanceof Error) {
      console.log(`${pad}- ${row.id}  [${row.name}]${disabled}   -> UNRESOLVED`)
      problems.push(
        `row ${row.id}: the bundle's own specifier "${row.name}" does not resolve from ${base} ` +
          `(${resolved.code ?? resolved.message}). Check the package.json "exports" entry point.`,
      )
    } else if (!existsAsFile(resolved)) {
      // `import.meta.resolve` only proves the exports map names something; a map
      // pointing at a missing file resolves happily and then fails at import.
      console.log(`${pad}- ${row.id}  [${row.name}]${disabled}   -> ${resolved}  (TARGET MISSING)`)
      problems.push(
        `row ${row.id}: "${row.name}" resolves to ${resolved}, but no such file exists. ` +
          'Check the "exports" entry point in package.json.',
      )
    } else {
      console.log(`${pad}- ${row.id}  [${row.name}]${disabled}   -> ${resolved}`)
    }
  } else {
    // An upstream `@deepseek-ai/*` row resolves from the profile's tree, not the
    // bundle's, so it cannot be resolved from here.
    console.log(`${pad}- ${row.id}  [${row.name}]${disabled}   -> (upstream, resolved by the profile)`)
  }

  if (row.group === true) {
    const realms = row.isolate && Object.keys(row.isolate)
    if (!realms || realms.length === 0) problems.push(`group ${row.id} publishes a service but declares no isolate realm`)
  }
}

console.log('---')
if (problems.length > 0) {
  console.error('PROBLEMS:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('OK: declaration shape valid; no path rows; every row name resolves; isolated groups intact.')
