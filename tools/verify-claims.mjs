/**
 * Measure the assembled persona of a preset composition and the per-tool schema
 * split of a recorded session, so a stated number can be checked against bytes.
 *
 *   node presets/local-lite/tools/verify-claims.mjs <composition.yml> [session.zstd ...]
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Pull the `prefix:` block scalar out of a persona row. */
function personaText(compositionFile) {
  const text = readFileSync(compositionFile, 'utf8')
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*prefix:\s*\|-?\s*$/.test(line))
  if (start === -1) return undefined
  const indent = (lines[start].match(/^\s*/) ?? [''])[0].length
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') {
      body.push('')
      continue
    }
    const lead = (line.match(/^\s*/) ?? [''])[0].length
    if (lead <= indent) break
    body.push(line.slice(indent + 2))
  }
  while (body.length > 0 && body.at(-1) === '') body.pop()
  return body.join('\n')
}

/** Rough mixed CJK/ASCII token estimate, the same rule the other tools use. */
function approxTokens(text) {
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length
  return Math.round(cjk + (text.length - cjk) / 4)
}

/** The zstd frame run of a DSH session log, decoded. */
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

const [compositionArg, ...sessionArgs] = process.argv.slice(2)
const composition = resolve(compositionArg)

const persona = personaText(composition)
if (persona !== undefined) {
  console.log(`persona (${dirname(composition)})`)
  console.log(`  chars  : ${persona.length}  (plus the cwd line the preset appends)`)
  console.log(`  tokens : ~${approxTokens(persona)}`)
  console.log('  ---8<---')
  console.log(persona.split('\n').map((line) => `  ${line}`).join('\n'))
  console.log('  ---8<---')

  // Platform-specific tool names must not appear in a cross-platform persona.
  const leaks = ['pwsh', 'PowerShell', 'Select-String', '-Tail', 'bash'].filter((word) => persona.includes(word))
  console.log(`  platform-specific mentions: ${leaks.length === 0 ? '(none)' : leaks.join(', ')}`)
}

for (const sessionArg of sessionArgs) {
  const records = sessionRecords(sessionArg)
  const header = records.find((r) => r.type === 'request/header')
  const tools = header?.data?.header?.tools ?? []
  const system = records.filter((r) => r.type === 'system/message').at(-1)
  const systemText = system?.data?.message?.content?.map((b) => b.text ?? '').join('') ?? ''
  const toolsJson = JSON.stringify(tools)
  console.log(`\nsession ${sessionArg.split(/[\\/]/).at(-2)}`)
  console.log(`  system prompt : ${systemText.length} chars  ~${approxTokens(systemText)} tokens`)
  console.log(`  tool schemas  : ${tools.length} tools, ${toolsJson.length} bytes  ~${approxTokens(toolsJson)} tokens`)
  console.log(`  TOTAL         : ~${approxTokens(systemText) + approxTokens(toolsJson)} tokens`)
  const hostOnly = tools.map((t) => t.name).filter((n) => n.startsWith('ssh_') || n === 'load_workspace_dependencies')
  console.log(`  host-mounted tools present: ${hostOnly.length === 0 ? '(none)' : hostOnly.join(', ')}`)
  console.log('  tools:')
  for (const tool of [...tools].sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)) {
    console.log(`    ${String(approxTokens(JSON.stringify(tool))).padStart(4)} tok  ${tool.name}`)
  }
}
