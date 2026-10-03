// Report the standing per-request prompt cost of a session: the resolved system
// prompt plus the tool schemas, which repeat on every model step.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const buf = readFileSync(process.argv[2])

function declaredSize(offset) {
  const descriptor = buf[offset + 4]
  const fcsFlag = descriptor >> 6
  let cursor = offset + 6
  if ((descriptor & 0b100) !== 0) cursor += 4
  if (fcsFlag === 0) return (descriptor & 0b100000) !== 0 ? buf.readUInt8(cursor) : null
  if (fcsFlag === 1) return buf.readUInt16LE(cursor) + 256
  if (fcsFlag === 2) return buf.readUInt32LE(cursor)
  return Number(buf.readBigUInt64LE(cursor))
}

function frameLength(offset, expected) {
  const limit = buf.length - offset
  const ok = (length) => {
    if (length > limit) return false
    let out
    try {
      out = zstdDecompressSync(buf.subarray(offset, offset + length))
    } catch {
      return false
    }
    return expected === null ? out.length > 0 : out.length === expected
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

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const parts = []
let cursor = 0
while (cursor < buf.length) {
  if (buf[cursor] !== 0x28 || buf[cursor + 1] !== 0xb5) {
    const next = buf.indexOf(MAGIC, cursor)
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

/** Rough token estimate for mixed CJK/ASCII text, matching the usual rules of thumb. */
function approxTokens(text) {
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length
  return Math.round(cjk + (text.length - cjk) / 4)
}

const systemRecords = records.filter((r) => r.type === 'system/message')
const headerRecord = records.find((r) => r.type === 'request/header')
const contextRecord = records.find((r) => r.type === 'request/context')

// The LAST system/message is the prompt as it stands now.
const latest = systemRecords.at(-1)
const systemText = latest?.data?.message?.content?.map((block) => block.text ?? '').join('') ?? ''

/**
 * Which preset the session ACTUALLY ran, judged from the wire rather than the
 * header. The header's `agentPreset` is written when the session record is
 * created — before the preset is bound — so it reads "standard" even for
 * sessions that then bound to a preset, or to no preset at all. What the model
 * was really sent is the only trustworthy evidence.
 */
const toolNames = (headerRecord?.data?.header?.tools ?? []).map((tool) => tool?.name ?? tool?.function?.name ?? '?')

/**
 * Whether a row name matches, treating an absent name as "no opinion".
 * @param name - the candidate tool name, possibly undefined.
 * @param pattern - substring to look for.
 */
const matches = (name, pattern) => typeof name === 'string' && name.includes(pattern)

function presetVerdict() {
  if (toolNames.length === 0) return { label: 'unknown', why: 'no tool schemas recorded' }
  // tool-surface is this preset's own plugin and its whole job is masking the
  // inherited global surface, so a recorded global tool is proof it did not run.
  const globalOnly = toolNames.filter((name) => matches(name, 'ssh_'))
  if (globalOnly.length > 0) {
    return {
      label: 'not local-lite',
      why: `inherited global tools are still on the wire (${globalOnly.join(', ')}), so tool-surface did not restrict this session`,
    }
  }
  if (systemText.includes('本地精简模式')) {
    return { label: 'local-lite', why: 'the persona is this preset\'s own, and the inherited global tools were masked' }
  }
  return { label: 'another preset', why: 'no inherited global tools, but the system prompt is not this preset\'s persona' }
}

const verdict = presetVerdict()
console.log(`=== ${verdict.label} (${verdict.why}) ===`)
const sessionRecord = records.find((r) => r.type === 'session')
console.log(`session header agentPreset: ${sessionRecord?.agentPreset ?? sessionRecord?.data?.agentPreset ?? '?'}  [written at session creation, before binding]`)
if (contextRecord) {
  console.log(`route: ${contextRecord.data.provider} / ${contextRecord.data.model}  contextWindow=${contextRecord.data.contextWindow}`)
}
console.log(`system/message records: ${systemRecords.length} (prompt was rewritten ${systemRecords.length} time(s))`)
console.log('')
console.log(`SYSTEM PROMPT: ${systemText.length} chars  ~${approxTokens(systemText)} tokens`)
console.log('---8<--- system prompt ---8<---')
console.log(systemText)
console.log('---8<--- end ---8<---')

const tools = headerRecord?.data?.header?.tools
if (Array.isArray(tools)) {
  const toolsJson = JSON.stringify(tools)
  console.log('')
  console.log(`TOOL SCHEMAS: ${tools.length} tools, ${toolsJson.length} bytes  ~${approxTokens(toolsJson)} tokens`)
  const rows = tools
    .map((tool) => {
      const json = JSON.stringify(tool)
      return { name: tool?.name ?? tool?.function?.name ?? '?', chars: json.length, tokens: approxTokens(json) }
    })
    .sort((a, b) => b.chars - a.chars)
  for (const row of rows) {
    console.log(`  ${String(row.tokens).padStart(5)} tok  ${String(row.chars).padStart(6)} ch  ${row.name}`)
  }
  const total = approxTokens(systemText) + approxTokens(toolsJson)
  console.log('')
  console.log(`STANDING PER-REQUEST COST: ~${total} tokens (system prompt + tool schemas)`)
}
