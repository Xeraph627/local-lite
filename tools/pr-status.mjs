/**
 * Read or update the GitHub PR of the local-lite submission: check-runs,
 * workflow runs and review state, plus replacing the description from a file.
 * The token comes from git's credential helper, so it never lands on disk or in
 * shell history.
 *
 *   node pr-status.mjs <owner/repo> <pr-number>
 *   node pr-status.mjs <owner/repo> <pr-number> --body <path-to-markdown>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const bodyFlag = args.indexOf('--body')
const bodyFile = bodyFlag === -1 ? undefined : args[bodyFlag + 1]
// Remove the flag and its value only when the flag is present. Testing the
// indices directly is wrong: with no flag, bodyFlag is -1 and bodyFlag + 1 is 0,
// which would silently drop the first positional argument.
const positional = args.filter((arg, index) => !(bodyFlag !== -1 && (index === bodyFlag || index === bodyFlag + 1)))
const [repo, prNumber] = positional
if (!repo || !prNumber) {
  console.error('usage: node pr-status.mjs <owner/repo> <pr-number> [--body <file.md>]')
  process.exit(2)
}

/** The stored GitHub credential, via git's configured helper. */
function readToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const line = out.split('\n').find((l) => l.startsWith('password='))
  if (line === undefined) throw new Error('no stored credential for github.com')
  return line.slice('password='.length)
}

const token = readToken()

/**
 * One GitHub API call, retried past transient local socket failures.
 *
 * This machine runs a local HTTPS accelerator that binds ephemeral ports near
 * 127.0.0.1:443; a burst of requests can make Node's raw sockets fail with
 * `EADDRINUSE 127.0.0.1:443` where git's own transport still succeeds. Those
 * clear within seconds, so a short retry beats reporting a false API failure.
 */
async function api(path, init = {}) {
  const request = {
    ...init,
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-agent',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  }
  let lastError
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`https://api.github.com${path}`, request)
      if (!response.ok) throw new Error(`${path} -> ${response.status} ${response.statusText}`)
      return await response.json()
    } catch (error) {
      lastError = error
      const transient = /EADDRINUSE|ECONNRESET|socket hang up|UNABLE_TO_VERIFY/i.test(String(error?.cause ?? error))
      if (!transient || attempt === 5) break
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000))
    }
  }
  throw lastError
}

if (bodyFile !== undefined) {
  const body = readFileSync(bodyFile, 'utf8')
  const updated = await api(`/repos/${repo}/pulls/${prNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  })
  console.log(`description updated: ${body.length} chars on PR #${updated.number}`)
}

const pr = await api(`/repos/${repo}/pulls/${prNumber}`)
console.log(`PR #${pr.number}  ${pr.state}  mergeable_state=${pr.mergeable_state}`)
console.log(`  ${pr.title}`)
console.log(`  ${pr.base.label} <- ${pr.head.label}`)
console.log(`  files ${pr.changed_files}  +${pr.additions} -${pr.deletions}`)
console.log(`  url ${pr.html_url}`)
console.log(`  assignees: ${(pr.assignees ?? []).map((a) => a.login).join(', ') || '(none)'}`)
console.log(`  reviewers: ${(pr.requested_reviewers ?? []).map((r) => r.login).join(', ') || '(none)'}`)
console.log(`  labels:    ${(pr.labels ?? []).map((l) => l.name).join(', ') || '(none)'}`)

const checks = await api(`/repos/${repo}/commits/${pr.head.sha}/check-runs`)
console.log(`\ncheck-runs (${checks.total_count}):`)
for (const run of checks.check_runs) {
  console.log(`  ${run.name}  ${run.status}/${run.conclusion ?? '-'}`)
}

const runs = await api(`/repos/${repo}/actions/runs?head_sha=${pr.head.sha}&per_page=20`)
console.log(`\nworkflow runs (${runs.total_count}):`)
for (const run of runs.workflow_runs) {
  console.log(`  ${run.name}  ${run.status}/${run.conclusion ?? '-'}  ${run.html_url}`)
}
