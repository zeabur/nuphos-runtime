import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const startScript = new URL('../image/runtime-start.sh', import.meta.url).pathname

// Pinned in nuphos's backend test too. The backend derives the operator key from the
// password it was given and the container derives it from the password it was started
// with; if these two drift, every self-hosted runtime silently loses its operator
// channel — status, pending decisions and Codex sign-in all go dark.
const VECTORS = [
  [
    'correct-horse-battery-staple-0123456789',
    '78e1724e5d59fee7238251e59f3571e4cb5587f14f649e324efae6f25b85ad8e',
  ],
  [
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'c4838404cd7d81464a7ee6e518c24d3c1a5fc4a22525944d79956be27bb990f2',
  ],
]

/** Run the start script with a probe in place of openab and report what it saw. */
function start(env) {
  const workspace = mkdtempSync(join(tmpdir(), 'nuphos-start-'))
  const result = spawnSync(
    'sh',
    [startScript, 'node', '-e', 'process.stdout.write(JSON.stringify(process.env))'],
    {
      env: { PATH: process.env.PATH, NUPHOS_RUNTIME_WORKSPACE: workspace, ...env },
      encoding: 'utf8',
    },
  )

  assert.equal(result.status, 0, result.stderr)

  return { env: JSON.parse(result.stdout), workspace, stderr: result.stderr }
}

test('the operator key is derived from the password alone', () => {
  for (const [password, expected] of VECTORS) {
    const { env } = start({ OPENAB_ACP_AUTH_KEY: password })

    assert.equal(env.OPENAB_ACP_CONTROL_KEY, expected)
    // openab refuses an operator key equal to the chat one, and floors it at 32.
    assert.notEqual(env.OPENAB_ACP_CONTROL_KEY, password)
    assert.ok(env.OPENAB_ACP_CONTROL_KEY.length >= 32)
    assert.equal(env.OPENAB_ACP_AUTH_KEY, password)
  }
})

test('an explicit operator key still wins, so provisioned pods are untouched', () => {
  // The provisioner sets both from a Secret; nothing here may second-guess that.
  const explicit = 'provisioner-issued-operator-key-0123456789abcdef'
  const { env } = start({
    OPENAB_ACP_AUTH_KEY: 'provisioner-issued-transport-key-0123456789',
    OPENAB_ACP_CONTROL_KEY: explicit,
  })

  assert.equal(env.OPENAB_ACP_CONTROL_KEY, explicit)
})

test('the same password pasted into both variables still yields a working operator key', () => {
  // openab would silently discard an operator key equal to the chat one, leaving the
  // operator channel dark with no error. Treat it as "one password" instead.
  const [password, expected] = VECTORS[0]
  const { env } = start({ OPENAB_ACP_AUTH_KEY: password, OPENAB_ACP_CONTROL_KEY: password })

  assert.equal(env.OPENAB_ACP_CONTROL_KEY, expected)
})

test('without a password there is nothing to derive, and nothing is invented', () => {
  const { env } = start({})

  assert.equal(env.OPENAB_ACP_CONTROL_KEY, undefined)
  assert.equal(env.OPENAB_ACP_AUTH_KEY, undefined)
})

test('the password never reaches argv or the output', () => {
  const [password] = VECTORS[0]
  const { stderr } = start({ OPENAB_ACP_AUTH_KEY: password })

  assert.equal(stderr.includes(password), false)
  // node is handed the password through its environment; the script text passes no
  // variable on the command line.
  assert.doesNotMatch(readFileSync(startScript, 'utf8'), /node -e[^\n]*\$OPENAB_ACP_AUTH_KEY/u)
})

test('the workspace is laid out the way a provisioned pod lays it out', () => {
  const { workspace } = start({ OPENAB_ACP_AUTH_KEY: VECTORS[0][0] })

  assert.equal(existsSync(join(workspace, '.claude')), true)
  assert.equal(readlinkSync(join(workspace, 'skills')), '.claude/skills')
  // Codex reads its own path, and deduplicates by absolute path.
  assert.equal(readlinkSync(join(workspace, '.agents/skills')), '../.claude/skills')

  // Starting again finds the layout in place and leaves it alone.
  const again = spawnSync('sh', [startScript, 'true'], {
    env: { PATH: process.env.PATH, NUPHOS_RUNTIME_WORKSPACE: workspace },
    encoding: 'utf8',
  })

  assert.equal(again.status, 0, again.stderr)
  assert.equal(readlinkSync(join(workspace, 'skills')), '.claude/skills')
})

test('an unwritable workspace does not stop the runtime starting', () => {
  const result = spawnSync('sh', [startScript, 'true'], {
    env: { PATH: process.env.PATH, NUPHOS_RUNTIME_WORKSPACE: '/proc/nuphos-cannot-exist' },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
})

test('with no command it becomes openab with the baked config', () => {
  // Stub openab on PATH to record how it was invoked.
  const bin = mkdtempSync(join(tmpdir(), 'nuphos-start-bin-'))
  const record = join(bin, 'argv')

  spawnSync('sh', ['-c', `printf '#!/bin/sh\\nprintf "%%s " "$@" > ${record}\\n' > ${bin}/openab && chmod +x ${bin}/openab`])
  const result = spawnSync('sh', [startScript], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      NUPHOS_RUNTIME_WORKSPACE: mkdtempSync(join(tmpdir(), 'nuphos-start-')),
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(record, 'utf8').trim(), 'run -c /etc/openab/config.toml')
})
