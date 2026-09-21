import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const dockerfile = readFileSync(new URL('../image/Dockerfile', import.meta.url), 'utf8')
const build = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8')

const LOGIN_COMMAND = 'node /opt/nuphos-runtime/codex-login.mjs --install'
const AUTH_FILE = '/home/node/.codex/auth.json'

test('the image hands OpenAB the sign-in command and the credential path', () => {
  assert.match(dockerfile, /^ARG RUNTIME_LOGIN_COMMAND$/mu)
  assert.match(dockerfile, /^ARG RUNTIME_AUTH_FILE$/mu)
  assert.match(dockerfile, /^ENV OPENAB_RUNTIME_LOGIN_COMMAND="\$\{RUNTIME_LOGIN_COMMAND\}" \\$/mu)
  assert.match(dockerfile, /^ {4}OPENAB_RUNTIME_AUTH_FILE="\$\{RUNTIME_AUTH_FILE\}"$/mu)
})

test('the published Codex image carries both values and the Claude Code image carries neither', () => {
  assert.ok(build.includes(`LOGIN_COMMAND='${LOGIN_COMMAND}'`))
  assert.ok(build.includes(`AUTH_FILE='${AUTH_FILE}'`))
  // An empty `OPENAB_RUNTIME_AUTH_FILE` is what makes `_openab/runtime/state` answer
  // "cannot tell" instead of "signed out". A Claude Code account arrives with the
  // session, so claiming it is absent would report every working runtime as signed out.
  assert.ok(build.includes("LOGIN_COMMAND=''"))
  assert.ok(build.includes("AUTH_FILE=''"))
  assert.ok(build.includes('RUNTIME_LOGIN_COMMAND=${{ steps.tags.outputs.login_command }}'))
  assert.ok(build.includes('RUNTIME_AUTH_FILE=${{ steps.tags.outputs.auth_file }}'))
})

test('the image bakes the ACP environment a provisioned pod has always had', () => {
  // A self-hosted container reaching these by hand was the difference between a
  // runtime that chats with tools and one that accepts a session and then refuses
  // its first prompt. openab reads all three only as environment, so config.toml
  // cannot carry them.
  assert.match(dockerfile, /^ENV OPENAB_ACP_MCP_SERVERS=true \\$/mu)
  assert.match(dockerfile, /^ {4}OPENAB_ACP_STREAMING=true \\$/mu)
  assert.match(dockerfile, /^ {4}GATEWAY_ALLOWED_USERS=acp_client$/mu)
  // The operator's own switch for exposing /acp stays the operator's.
  assert.doesNotMatch(dockerfile, /ENV[^\n]*OPENAB_ACP_ENABLED/u)
  assert.doesNotMatch(dockerfile, /^ {4}OPENAB_ACP_ENABLED/mu)
})

test('the sign-in command names the flag that keeps the credential in the container', () => {
  // Without `--install` the credential rides the frame back to the caller, which is
  // the Kubernetes exec path's contract, not this one's.
  assert.ok(LOGIN_COMMAND.endsWith(' --install'))
  const login = readFileSync(new URL('../image/codex-login.mjs', import.meta.url), 'utf8')

  assert.ok(login.includes("process.argv.includes('--install')"))
})
