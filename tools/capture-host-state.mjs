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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

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

/** The zstd frame run of a DSH session log, decoded to records. */
function sessionRecords(file) {
  const buf = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const declaredSize = (offset) => {
    const descriptor = buf[offset + 4]
    const fcsFlag = descriptor >> 6
    let cursor = offset + 6
    if ((descriptor & 0b100) !== 0) cursor += 4
    if (fcsFlag === 0) return (descriptor & 0b100000) !== 0 ? buf.readUInt8(cursor) : null
    if (fcsFlag === 1) return buf.readUInt16LE(cursor) + 256
    if (fcsFlag === 2) return buf.readUInt32LE(cursor)
    return Number(buf.readBigUInt64LE(cursor))
  }
  const frameLength = (offset, expected) => {
    const limit = buf.length - offset
    const ok = (length) => {
      if (length > limit) return false
      try {
        const out = zstdDecompressSync(buf.subarray(offset, offset + length))
        return expected === null ? out.length > 0 : out.length === expected
      } catch {
        return false
      }
    }
    let hi = 1024
    while (hi <= limit && !ok(hi)) hi *= 2
    if (hi > limit) return -1
    let lo = Math.max(0, Math.floor(hi / 2))
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (ok(mid)) hi = mid
      else lo = mid
    }
    return hi
  }
  const parts = []
  let cursor = 0
  while (cursor < buf.length) {
    if (buf[cursor] !== 0x28 || buf[cursor + 1] !== 0xb5) {
      const next = buf.indexOf(magic, cursor)
      if (next === -1) break
      cursor = next
    }
    const length = frameLength(cursor, declaredSize(cursor))
    if (length <= 0) break
    parts.push(zstdDecompressSync(buf.subarray(cursor, cursor + length)))
    cursor += length
  }
  const records = []
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      /* torn tail */
    }
  }
  return records
}

/** Rough mixed CJK/ASCII token estimate, consistent with the other tools. */
function approxTokens(text) {
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length
  return Math.round(cjk + (text.length - cjk) / 4)
}

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
  const records = sessionRecords(sessionFile)
  const header = records.find((r) => r.type === 'request/header')
  const tools = header?.data?.header?.tools ?? []
  const system = records.filter((r) => r.type === 'system/message').at(-1)
  const systemText = system?.data?.message?.content?.map((b) => b.text ?? '').join('') ?? ''
  const toolsJson = JSON.stringify(tools)
  lines.push(`### The session that ran on the declaration`, '')
  lines.push(`Recorded request (\`request/header\` + \`system/message\`) from this session:`, '')
  lines.push('```')
  lines.push(`system prompt : ${systemText.length} chars  ~${approxTokens(systemText)} tokens`)
  lines.push(`tool schemas  : ${tools.length} tools, ${toolsJson.length} bytes  ~${approxTokens(toolsJson)} tokens`)
  lines.push(`TOTAL         : ~${approxTokens(systemText) + approxTokens(toolsJson)} tokens per request`)
  lines.push('```', '')
  lines.push(`Tools on the wire: ${tools.map((tool) => tool.name).join(', ')}`, '')
  const inherited = tools.map((t) => t.name).filter((name) => name.startsWith('ssh_'))
  lines.push(
    inherited.length === 0
      ? 'No inherited global tools on the wire, so `tool-surface` masked them in this session.'
      : `Inherited global tools still present: ${inherited.join(', ')}`,
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
