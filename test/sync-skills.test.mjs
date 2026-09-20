import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const syncScript = fileURLToPath(new URL('../image/sync-skills.sh', import.meta.url))

const encode = (value) => Buffer.from(value).toString('base64')

async function serveBundles(handler) {
  const server = createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(handler(request)))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    url: `http://127.0.0.1:${server.address().port}/skills`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function sync(env) {
  const child = spawn('bash', [syncScript], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''

  child.stdout.resume()
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

// The runtime image is Debian; BSD mv has no -T, so the atomic symlink swap
// needs GNU coreutils when the test runs on a developer's macOS machine.
const gnuBin = ['/opt/homebrew/opt/coreutils/libexec/gnubin', '/usr/local/opt/coreutils/libexec/gnubin'].find(
  (dir) => existsSync(join(dir, 'mv')),
)

const workspaceEnv = (url) => ({
  ...process.env,
  PATH: gnuBin ? `${gnuBin}:${process.env.PATH}` : process.env.PATH,
  NUPHOS_RUNTIME_WORKSPACE: mkdtempSync(join(tmpdir(), 'nuphos-runtime-skills-')),
  NUPHOS_RUNTIME_SKILLS_URL: url,
  NUPHOS_RUNTIME_SKILLS_TOKEN: 'narrow-token',
})

test('installs the authenticated bundle with executable scripts', async () => {
  const observed = { authorization: null }
  const server = await serveBundles((request) => {
    observed.authorization = request.headers.authorization ?? null

    return {
      revision: 'rev-1',
      files: [
        { path: 'nuphos-plan/SKILL.md', contentBase64: encode('# Plan'), executable: false },
        {
          path: 'nuphos-plan/scripts/create.sh',
          contentBase64: encode('#!/bin/sh\n'),
          executable: true,
        },
        {
          path: 'architecture-diagram/SKILL.md',
          contentBase64: encode('# Architecture'),
          executable: false,
        },
        {
          path: 'cost-management/SKILL.md',
          contentBase64: encode('# Cost Management'),
          executable: false,
        },
      ],
    }
  })

  try {
    const env = workspaceEnv(server.url)
    const skills = join(env.NUPHOS_RUNTIME_WORKSPACE, '.claude/skills')
    const { code, stderr } = await sync(env)

    assert.equal(code, 0)
    assert.equal(stderr, '')
    assert.equal(observed.authorization, 'Bearer narrow-token')
    assert.equal(readFileSync(join(skills, 'nuphos-plan/SKILL.md'), 'utf8'), '# Plan')
    assert.notEqual(statSync(join(skills, 'nuphos-plan/scripts/create.sh')).mode & 0o111, 0)
    assert.equal(readFileSync(join(skills, 'architecture-diagram/SKILL.md'), 'utf8'), '# Architecture')
    assert.equal(readFileSync(join(skills, 'cost-management/SKILL.md'), 'utf8'), '# Cost Management')
  } finally {
    await server.close()
  }
})

test('rejects a bundle that points outside the skills tree', async () => {
  const server = await serveBundles(() => ({
    revision: 'rev-1',
    files: [{ path: '../escaped/SKILL.md', contentBase64: encode('# Escaped'), executable: false }],
  }))

  try {
    const env = workspaceEnv(server.url)
    const { code, stderr } = await sync(env)

    assert.notEqual(code, 0)
    assert.ok(stderr.includes('unsafe runtime skill path: ../escaped/SKILL.md'))
    assert.equal(existsSync(join(env.NUPHOS_RUNTIME_WORKSPACE, '.claude/skills')), false)
    assert.equal(existsSync(join(env.NUPHOS_RUNTIME_WORKSPACE, '.claude/escaped')), false)
  } finally {
    await server.close()
  }
})

test('leaves the live tree untouched when the bundle has not changed', async () => {
  const server = await serveBundles(() => ({
    revision: 'rev-1',
    files: [{ path: 'kept/SKILL.md', contentBase64: encode('# One'), executable: false }],
  }))

  try {
    const env = workspaceEnv(server.url)
    const claude = join(env.NUPHOS_RUNTIME_WORKSPACE, '.claude')
    const skills = join(claude, 'skills')
    const run = async () => {
      const { code, stderr } = await sync(env)

      assert.equal(stderr, '')
      assert.equal(code, 0)
    }

    await run()
    const installed = readlinkSync(skills)
    const before = statSync(join(skills, 'kept/SKILL.md')).ino

    await run()
    await run()

    assert.equal(readlinkSync(skills), installed)
    assert.equal(statSync(join(skills, 'kept/SKILL.md')).ino, before)
    assert.equal(readFileSync(join(skills, 'kept/SKILL.md'), 'utf8'), '# One')
    assert.deepEqual(
      readdirSync(claude).filter((entry) => entry.startsWith('skills.')),
      [installed],
    )
  } finally {
    await server.close()
  }
})

test('swaps a new bundle in without ever exposing a missing tree', async () => {
  const bundles = [
    {
      revision: 'rev-1',
      files: [
        { path: '_runtime/settings.json', contentBase64: encode('{"model":"old"}'), executable: false },
        { path: 'kept/SKILL.md', contentBase64: encode('# One'), executable: false },
        { path: 'dropped/SKILL.md', contentBase64: encode('# Gone'), executable: false },
      ],
    },
    {
      revision: 'rev-2',
      files: [
        { path: '_runtime/settings.json', contentBase64: encode('{"model":"new"}'), executable: false },
        { path: 'kept/SKILL.md', contentBase64: encode('# Two'), executable: false },
        { path: 'added/scripts/run.sh', contentBase64: encode('#!/bin/sh\n'), executable: true },
      ],
    },
  ]
  let served = 0
  const server = await serveBundles(() => bundles[Math.min(served++, bundles.length - 1)])

  try {
    const env = workspaceEnv(server.url)
    const claude = join(env.NUPHOS_RUNTIME_WORKSPACE, '.claude')
    const skills = join(claude, 'skills')
    const run = async () => {
      const { code, stderr } = await sync(env)

      assert.equal(stderr, '')
      assert.equal(code, 0)
    }

    await run()

    assert.equal(readFileSync(join(skills, 'kept/SKILL.md'), 'utf8'), '# One')
    assert.equal(readFileSync(join(claude, 'settings.json'), 'utf8'), '{"model":"old"}')
    assert.equal(readFileSync(join(claude, '.skills-revision'), 'utf8'), 'rev-1')

    await run()

    assert.equal(lstatSync(skills).isSymbolicLink(), true)
    assert.equal(readFileSync(join(skills, 'kept/SKILL.md'), 'utf8'), '# Two')
    assert.equal(readFileSync(join(skills, 'added/scripts/run.sh'), 'utf8'), '#!/bin/sh\n')
    assert.notEqual(statSync(join(skills, 'added/scripts/run.sh')).mode & 0o111, 0)
    assert.equal(existsSync(join(skills, 'dropped/SKILL.md')), false)
    assert.equal(readFileSync(join(claude, 'settings.json'), 'utf8'), '{"model":"new"}')
    assert.equal(readFileSync(join(claude, '.skills-revision'), 'utf8'), 'rev-2')
    assert.deepEqual(
      readdirSync(claude).filter((entry) => entry.startsWith('skills.')),
      [readlinkSync(skills)],
    )
    assert.ok(readlinkSync(skills).startsWith('skills.rev-2.'))
  } finally {
    await server.close()
  }
})
