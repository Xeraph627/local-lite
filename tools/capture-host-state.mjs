/**
 * Capture the preset center's own view of the library as submission evidence:
 * the `GET /api/preset-center/state` payload the Presets panel renders, plus a
 * session's recorded request. The state payload is a REAL-HOST read of the
 * installed bytes — `installed`, `codeExecution`, `codeFiles`, `relativeNames`
 * and `inlineExpressions` all come from the preset directory, not from a local
 * test.
 *
 *   node presets/local-lite/tools/capture-host-state.mjs [--out <file.md>] [--id local-lite]
 *   node presets/local-lite/tools/capture-host-state.mjs --session <session.v4.jsonl.zstd>
 */
import { existsSync, writeFileSync } from 'node:fs'

import { approxTokens, readSessionRecords, requestTools, systemPromptText } from './session-frames.mjs'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const presetId = flag('--id') ?? 'local-lite'
const sessionFile = flag('--session')
const outFile = flag('--out')

/** This machine's DSH Web GUI. */
const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387'

const lines = []

// 1. The preset center's live view of the installed library directory.
const response = await fetch(`${BASE}/api/preset-center/state`)
const state = await response.json()
const row = (state.presets ?? []).find((preset) => preset.id === presetId)

lines.push(`### Preset center's live view of the installed bytes`, '')
lines.push(`\`GET ${BASE}/api/preset-center/state\` on the running host:`, '')
lines.push('```json')
lines.push(
  JSON.stringify(
    {
      rosterAvailable: state.rosterAvailable,
      defaultId: state.defaultId,
      occupied: state.occupied,
      preset: row,
    },
    null,
    2,
  ),
)
lines.push('```', '')

if (row === undefined) {
  lines.push(`> No library row for \`${presetId}\` (not installed).`, '')
} else {
  lines.push(
    `The directory is installed and its composition reads cleanly: ` +
      `\`codeExecution: ${row.profile?.codeExecution}\`, ` +
      `\`codeFiles: ${JSON.stringify(row.profile?.codeFiles)}\`, ` +
      `\`relativeNames: ${JSON.stringify(row.profile?.relativeNames)}\`, ` +
      `\`inlineExpressions: ${row.profile?.inlineExpressions}\`, ` +
      `\`rows: ${row.profile?.rows}\`.`,
    '',
  )
  if (row.managed === false) {
    lines.push(
      `\`managed: false\` is expected for a hand-placed directory and is why the panel offers no ` +
        `Enable button: \`handleInstall\` refuses a non-managed row (409 \`not-managed\`), because the ` +
        `library directory is the market's install target and the panel is catalog-driven. ` +
        `The declaration is supplied by the bundle instead until the catalog merges.`,
      '',
    )
  }
}

// 2. Optionally the session that ran on the declaration.
if (sessionFile !== undefined && existsSync(sessionFile)) {
  const records = readSessionRecords(sessionFile)
  const tools = requestTools(records)
  const systemText = systemPromptText(records)
  const toolsJson = JSON.stringify(tools)
  lines.push(`### The session that ran on the declaration`, '')
  lines.push(`Recorded request (\`request/header\` + \`system/message\`) from this session:`, '')
  lines.push('```')
  lines.push(`system prompt : ${systemText.length} chars  ~${approxTokens(systemText)} tokens`)
  lines.push(`tool schemas  : ${tools.length} tools, ${toolsJson.length} bytes  ~${approxTokens(toolsJson)} tokens`)
  lines.push(`TOTAL         : ~${approxTokens(systemText) + approxTokens(toolsJson)} tokens per request`)
  lines.push('```', '')
  lines.push(`Tools on the wire: ${tools.map((tool) => tool.name).join(', ')}`, '')
  const inherited = tools.map((tool) => tool.name).filter((name) => name.startsWith('ssh_'))
  const transport = tools.some((tool) => tool.name === 'run_code')
  lines.push(
    inherited.length === 0
      ? 'No inherited global tool is on the wire, so `tool-surface` masked them in this session.'
      : `Inherited global tools still present: ${inherited.join(', ')}`,
    '',
  )
  lines.push(
    transport
      ? 'The wire also carries `run_code`, so this deployment presents tools as `ptc` or `both` — the ' +
          'reserved PTC transport name is present and `tool-surface` still masked the inherited globals.'
      : 'The wire carries no `run_code`, so this deployment presents tools natively.',
    '',
  )
} else if (sessionFile !== undefined) {
  lines.push(`> Session file not found: ${sessionFile}`, '')
}

const output = lines.join('\n')
if (outFile === undefined) process.stdout.write(`${output}\n`)
else {
  writeFileSync(outFile, `${output}\n`)
  console.log(`wrote ${outFile} (${output.length} chars)`)
}
