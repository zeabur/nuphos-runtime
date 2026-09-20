import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import { patchRuntimeDefaults } from '../runtime-defaults.mjs'
import { patchClaudeTurnCompletion } from './turn-completion.mjs'

const target = process.argv[2]
const source = readFileSync(target, 'utf8')
if (
  createHash('sha256').update(source).digest('hex') !==
  '0eeabe7242f82b2a27bd9a98c9812ff7fb29c4a67c1d289947b88bcacceb8548'
)
  throw new Error('Claude ACP bundle changed; review the Nuphos adapter patches.')
// Publish execution state from the SDK lifecycle, after the adapter has fenced
// owed trailing idles against its current native turn. Tool updates never enter
// this path and cannot start a turn.
const stateAnchor =
  '                                break;\n                            }\n                            case "memory_recall": {'
if (source.split(stateAnchor).length !== 2)
  throw new Error('Expected one Claude session-state lifecycle handoff.')
const mcpAnchor = '            for (const server of params.mcpServers) {'
if (source.split(mcpAnchor).length !== 2) throw new Error('Expected one Claude MCP server handoff.')
const closeAnchor = '        session.queryClosed = true;'
if (source.split(closeAnchor).length !== 2)
  throw new Error('Expected one Claude native query teardown.')
const statePatched = patchClaudeTurnCompletion(source)
  .replace(
    mcpAnchor,
    '            for (const server of nuphosBridgeMcpServers(params.mcpServers)) {',
  )
  .replace(
    closeAnchor,
    `${closeAnchor}
        const stateSessionId = Object.entries(this.sessions).find(([, value]) => value === session)?.[0];
        if (stateSessionId) void this.client.sessionUpdate({
            sessionId: stateSessionId,
            update: { sessionUpdate: "session_info_update", _meta: {
                "ai.nuphos/sessionState": { state: "interrupted" }
            }}
        }).catch((error) => this.logger.error("Could not publish runtime interruption", error));
`,
  )
  .replace(
    '                                    await session.titles.onTurnEnd(session);',
    '                                    // Runtime state is published before optional title enrichment.',
  )
  .replace(
    stateAnchor,
    `
                                await sendUpdate({
                                    sessionId: params.sessionId,
                                    update: {
                                        sessionUpdate: "session_info_update",
                                        _meta: { "ai.nuphos/sessionState": {
                                            state: session.queryClosed ? "interrupted" : session.activeTurn && !session.activeTurn.settled
                                                ? "active"
                                                : message.state === "idle" ? "idle" : "active"
                                        }}
                                    }
                                });
                                if (message.state === "idle") await session.titles.onTurnEnd(session);
${stateAnchor}`,
  )
const helper = readFileSync(new URL('../mcp-bridge-config.mjs', import.meta.url), 'utf8')
writeFileSync(target, patchRuntimeDefaults(`${helper}\n${statePatched}`))
