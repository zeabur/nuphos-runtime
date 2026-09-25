import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import { patchRuntimeDefaults } from '../runtime-defaults.mjs'
import { patchClaudeSessionState } from './session-state.mjs'
import { patchClaudeTurnCompletion } from './turn-completion.mjs'

const target = process.argv[2]
const source = readFileSync(target, 'utf8')
if (
  createHash('sha256').update(source).digest('hex') !==
  '0eeabe7242f82b2a27bd9a98c9812ff7fb29c4a67c1d289947b88bcacceb8548'
)
  throw new Error('Claude ACP bundle changed; review the Nuphos adapter patches.')
const mcpAnchor = '            for (const server of params.mcpServers) {'
if (source.split(mcpAnchor).length !== 2) throw new Error('Expected one Claude MCP server handoff.')
const patched = patchClaudeSessionState(patchClaudeTurnCompletion(source)).replace(
  mcpAnchor,
  '            for (const server of nuphosBridgeMcpServers(params.mcpServers)) {',
)
const helper = readFileSync(new URL('../mcp-bridge-config.mjs', import.meta.url), 'utf8')
writeFileSync(target, patchRuntimeDefaults(`${helper}\n${patched}`))
