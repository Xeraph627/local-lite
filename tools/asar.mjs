// Read-only helpers over the DSH app.asar: list entries matching a substring,
// extract one entry, or grep entry contents. Usage:
//   node tools/asar.mjs list   <asar> <substring>
//   node tools/asar.mjs cat    <asar> <exact/path>
//   node tools/asar.mjs grep   <asar> <regex> <pathRegex>
import { readFileSync } from 'node:fs'

const [mode, file, ...rest] = process.argv.slice(2)
const fd = readFileSync(file)
const headerSize = fd.readUInt32LE(4)
const headerJsonSize = fd.readUInt32LE(8)
const raw = fd.subarray(16, 16 + headerJsonSize).toString('utf8')
const header = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1))
const baseOffset = 8 + headerSize

const files = new Map()
;(function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (value.files) walk(value, p)
    else files.set(p, value)
  }
})(header, '')

const read = ([, entry]) =>
  fd.subarray(baseOffset + Number(entry.offset), baseOffset + Number(entry.offset) + entry.size)

if (mode === 'list') {
  const needle = rest[0] ?? ''
  for (const [p, e] of files) if (p.includes(needle)) console.log(`${e.size}\t${p}`)
} else if (mode === 'cat') {
  const entry = files.get(rest[0])
  if (!entry) {
    console.error(`not found: ${rest[0]}`)
    process.exit(1)
  }
  process.stdout.write(read([rest[0], entry]))
} else if (mode === 'grep') {
  const pattern = new RegExp(rest[0], 'i')
  const pathFilter = rest[1] ? new RegExp(rest[1], 'i') : null
  for (const [p, e] of files) {
    if (pathFilter && !pathFilter.test(p)) continue
    if (e.size > 4_000_000) continue
    const lines = read([p, e]).toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (pattern.test(lines[i])) console.log(`${p}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
    }
  }
}
