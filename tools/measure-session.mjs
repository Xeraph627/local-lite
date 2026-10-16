// Report the standing per-request prompt cost of a session: the resolved system
// prompt plus the tool schemas, which repeat on every model step.
//
//   node measure-session.mjs <session.v4.jsonl.zstd>
import { approxTokens, readSessionRecords, requestTools, sessionHeader, systemPromptText } from './session-frames.mjs'

const records = readSessionRecords(process.argv[2])
const tools = requestTools(records)
const systemText = systemPromptText(records)

/**
 * Which preset the session ACTUALLY ran, judged from the wire rather than the
 * header. The header's `agentPreset` is written when the session record is
 * created — before the preset is bound — so it reads "standard" even for
 * sessions that then bound to a preset. What the model was really sent is the
 * only trustworthy evidence.
 */
const toolNames = tools.map((tool) => tool?.name ?? tool?.function?.name ?? '?')
const matches = (name, pattern) => typeof name === 'string' && name.includes(pattern)

function presetVerdict() {
  if (toolNames.length === 0) return { label: 'unknown', why: 'no tool schemas recorded' }
  // An inherited global tool on the wire is proof tool-surface did not mask.
  const inherited = toolNames.filter((name) => matches(name, 'ssh_'))
  if (inherited.length > 0) {
    return {
      label: 'not local-lite',
      why: `inherited global tools are still on the wire (${inherited.join(', ')}), so tool-surface did not restrict this session`,
    }
  }
  if (systemText.includes('本地精简模式')) {
    return { label: 'local-lite', why: "the persona is this preset's own, and no inherited global tool is on the wire" }
  }
  return { label: 'another preset', why: "no inherited global tools, but the system prompt is not this preset's persona" }
}

const verdict = presetVerdict()
const header = sessionHeader(records)
console.log(`=== ${verdict.label} (${verdict.why}) ===`)
console.log(`session header agentPreset: ${header?.agentPreset ?? '?'}  [written at session creation, before binding]`)

const context = records.find((record) => record?.type === 'request/context')
if (context) {
  console.log(`route: ${context.data.provider} / ${context.data.model}  contextWindow=${context.data.contextWindow}`)
}
console.log(`system/message records: ${records.filter((record) => record?.type === 'system/message').length}`)
console.log('')
console.log(`SYSTEM PROMPT: ${systemText.length} chars  ~${approxTokens(systemText)} tokens`)
console.log('---8<--- system prompt ---8<---')
console.log(systemText)
console.log('---8<--- end ---8<---')

if (tools.length > 0) {
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
  console.log('')
  console.log(`STANDING PER-REQUEST COST: ~${approxTokens(systemText) + approxTokens(toolsJson)} tokens (system prompt + tool schemas)`)
}
