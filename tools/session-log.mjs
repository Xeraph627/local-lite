/**
 * Decode a DSH session log (a run of independent zstd frames) and print either
 * a compact event summary or one record's JSON.
 *
 *   node presets/local-lite/tools/session-log.mjs <session.v4.jsonl.zstd> [type]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const buf = readFileSync(process.argv[2])
const wantType = process.argv[3]

/** The frame header's declared decompressed size, or null when it has none. */
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

/**
 * The exact frame length at `offset`. A frame is whole when it decodes to
 * exactly the size its header declared — node:zlib returns an empty buffer
 * rather than throwing on truncated input, so the declared size is the oracle.
 */
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
    /* torn tail while the session is live */
  }
}

if (wantType) {
  for (const record of records.filter((r) => r.type === wantType)) console.log(JSON.stringify(record, null, 2))
  process.exit(0)
}

const counts = new Map()
for (const record of records) counts.set(record.type, (counts.get(record.type) ?? 0) + 1)
const header = records.find((r) => r.type === 'session')
console.log(`records : ${records.length}`)
console.log(`preset  : ${header?.agentPreset ?? '(no session header)'}`)
console.log(`cwd     : ${header?.cwd ?? '?'}`)
console.log('--- events ---')
for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${type}`)
