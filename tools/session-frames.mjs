/**
 * Decode a DSH session log.
 *
 * A log is a run of INDEPENDENT zstd frames, one per appended batch, and nothing
 * in the stream separates them. The only reliable frame boundary is the next
 * frame's magic number, so scan for those.
 *
 * Do NOT discover a frame's length by "the shortest prefix that decodes to
 * something" or by trusting the frame header's declared content size: many of
 * these frames carry `fcsFlag = 0` (no declared size), and a slice that runs past
 * a frame boundary decodes to the FOLLOWING frame's bytes and looks perfectly
 * valid. That mistake silently merges several records into one and reports a
 * nearly empty log — it hid three of the first four frames of a live session and
 * made a fully recorded conversation look like a bare session header.
 *
 * @module session-frames
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/** The zstd frame magic number. */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Start offsets of every zstd frame in a buffer, in order.
 * @param buf - the whole file.
 */
export function frameStarts(buf) {
  const starts = []
  let at = buf.indexOf(ZSTD_MAGIC)
  while (at !== -1) {
    starts.push(at)
    at = buf.indexOf(ZSTD_MAGIC, at + 4)
  }
  return starts
}

/**
 * Decode a session log file into its JSONL records.
 * A torn trailing frame (a session still being written) simply ends the walk.
 * @param file - path to `session.v4.jsonl.zstd`.
 * @returns every record that parsed, in log order.
 */
export function readSessionRecords(file) {
  const buf = readFileSync(file)
  const starts = frameStarts(buf)
  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(starts[index], end)))
    } catch {
      break
    }
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

/** The session header record, which carries cwd and the (pre-binding) preset id. */
export function sessionHeader(records) {
  return records.find((record) => record?.type === 'session')
}

/** The recorded request header: the tool schemas the model was actually sent. */
export function requestTools(records) {
  return records.find((record) => record?.type === 'request/header')?.data?.header?.tools ?? []
}

/** The latest recorded system prompt text. */
export function systemPromptText(records) {
  const latest = records.filter((record) => record?.type === 'system/message').at(-1)
  return latest?.data?.message?.content?.map((block) => block.text ?? '').join('') ?? ''
}

/** Rough mixed CJK/ASCII token estimate, consistent across the tools here. */
export function approxTokens(text) {
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length
  return Math.round(cjk + (text.length - cjk) / 4)
}
