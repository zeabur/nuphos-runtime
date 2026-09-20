// Invoked only through the backend's authenticated Kubernetes exec channel.
// stdout is a private protocol (including the final credential), never pod logs.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { pathToFileURL } from 'node:url'

export function deviceCodePrompt(output) {
  const plain = stripVTControlCharacters(output)
  if (!plain.includes('https://auth.openai.com/codex/device')) return null
  const userCode = /Enter this one-time code[^\n]*\n[ \t]*([A-Za-z0-9-]{4,32})[ \t]*\r?\n/u.exec(
    plain,
  )?.[1]
  return userCode
    ? { type: 'device', verificationUri: 'https://auth.openai.com/codex/device', userCode }
    : null
}

export async function runDeviceLogin({
  executable = process.execPath,
  args = ['/opt/nuphos-codex-acp/node_modules/@openai/codex/bin/codex.js'],
  emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`),
  signal,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nuphos-codex-login-'))
  try {
    const child = spawn(
      executable,
      [...args, '-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'],
      {
        // Do not inherit transport keys, actor tokens, or another Codex login.
        env: {
          HOME: '/home/node',
          CODEX_HOME: directory,
          PATH: '/usr/local/bin:/usr/bin:/bin',
          TERM: 'dumb',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // The npm CLI launches a native child. Cancel the entire process group,
        // otherwise that child keeps the pipes and temporary login home alive.
        detached: process.platform !== 'win32',
      },
    )
    let output = ''
    let announced = false
    const collect = (chunk) => {
      if (announced) return
      output = (output + chunk.toString()).slice(-16_384)
      const prompt = deviceCodePrompt(output)
      if (prompt) {
        announced = true
        output = ''
        emit(prompt)
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const code = await new Promise((resolve, reject) => {
      let failure
      const stop = () => {
        failure = new Error('Codex login stopped')
        if (!child.pid) return
        try {
          if (process.platform === 'win32') child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') failure = error
        }
      }
      const timeout = setTimeout(stop, 15 * 60_000)
      signal?.addEventListener('abort', stop, { once: true })
      child.once('error', (error) => {
        failure = error
      })
      child.once('close', (exitCode) => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', stop)
        failure ? reject(new Error('Codex login stopped')) : resolve(exitCode)
      })
      if (signal?.aborted) stop()
    })
    if (code !== 0) throw new Error('Codex login did not complete')
    const authJson = await readFile(join(directory, 'auth.json'), 'utf8')
    if (authJson.length > 64 * 1024) throw new Error('Unexpected Codex login response')
    emit({ type: 'authenticated', authJson })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController()
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort())
  process.stdout.on('error', () => controller.abort())
  try {
    await runDeviceLogin({ signal: controller.signal })
  } catch {
    // Provider output can contain sensitive values; report only a fixed error.
    process.stdout.write(
      `${JSON.stringify({ type: 'error', message: 'Sign-in did not complete. Retry and check that device-code login is enabled in ChatGPT security settings.' })}\n`,
    )
    process.exitCode = 1
  }
}
