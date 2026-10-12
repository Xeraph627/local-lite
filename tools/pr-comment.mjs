/**
 * Post a comment on a GitHub issue or pull request, reading the body from a
 * file and the token from git's credential helper (so neither is echoed or
 * committed).
 *
 *   node pr-comment.mjs <owner/repo> <issue-or-pr-number> <body-file>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [repo, number, bodyFile] = process.argv.slice(2)
if (!repo || !number || !bodyFile) {
  console.error('usage: node pr-comment.mjs <owner/repo> <number> <body-file>')
  process.exit(2)
}

const out = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
})
const token = out.split('\n').find((l) => l.startsWith('password=')).slice('password='.length)

const body = readFileSync(bodyFile, 'utf8')

/**
 * Post the comment, retried past transient local socket failures. This machine
 * runs a local HTTPS accelerator whose ephemeral binds can make Node's raw
 * sockets fail with `EADDRINUSE 127.0.0.1:443`; those clear within seconds.
 */
async function post() {
  let lastError
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
        method: 'POST',
        headers: {
          authorization: `token ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'dsh-agent',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body }),
      })
      if (!response.ok) {
        throw new Error(`comment failed: ${response.status} ${response.statusText}\n${await response.text()}`)
      }
      return response.json()
    } catch (error) {
      lastError = error
      const transient = /EADDRINUSE|ECONNRESET|socket hang up|UNABLE_TO_VERIFY/i.test(String(error?.cause ?? error))
      if (!transient || attempt === 5) break
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000))
    }
  }
  throw lastError
}

const comment = await post()
console.log(`comment posted: ${comment.html_url}  (${body.length} chars)`)
