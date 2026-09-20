# Nuphos Runtime

The container image that runs a coding agent for [Nuphos](https://nuphos.ai).

A Nuphos runtime is a long-lived container with one coding agent inside it —
either **Claude Code** or **Codex** — reachable over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). The Nuphos
backend does not run the agent itself; it opens an ACP session against a
runtime and streams the conversation through it. This repository builds the
image those runtimes run.

Images are published to `ghcr.io/zeabur/nuphos-openab-runtime`.

## What is in the image

Three things, in layers:

1. **The OpenAB gateway.** [`openab`](https://github.com/openabdev/openab) is
   the process that owns the container: it accepts ACP over the network,
   supervises the agent, and keeps sessions alive across agent restarts. It is
   the image's entrypoint.
2. **The agent CLI and its ACP adapter.** For `claude-code`, that is
   `@anthropic-ai/claude-code` with `@agentclientprotocol/claude-agent-acp`;
   for `codex`, `@openai/codex` with `@agentclientprotocol/codex-acp`. The
   adapter translates ACP into whatever the CLI actually speaks.
3. **The Nuphos toolset layer**, built from [`image/`](image) in this
   repository: a set of patches to the adapters, a handful of helper programs,
   and the command-line tools an agent is expected to be able to reach for.

### The toolset layer

The adapters are patched at build time rather than forked. Each patch pins the
SHA-256 of the upstream bundle it edits, so an adapter upgrade fails the build
until someone re-reviews the patch.

| Path in the image | What it does |
| --- | --- |
| `/opt/nuphos-claude-agent-acp` | Claude adapter (0.74.0, Agent SDK 0.3.261), patched to publish session state and to bridge HTTP MCP servers |
| `/opt/nuphos-codex-acp` | Codex adapter (1.1.4, Codex CLI 0.153.4), patched for per-session instructions and environment, MCP bridging, and steering an active turn |
| `/opt/runtime-defaults.mjs` | Applies a model, reasoning effort and fast-mode default to a new session |
| `/opt/nuphos-runtime/mcp-http-bridge.mjs` | Relays a stdio MCP server to a bearer-authenticated HTTP endpoint, re-reading the token per request |
| `/opt/nuphos-runtime/runtime-guard.sh` | Sourced via `BASH_ENV`; refreshes per-turn credentials into the shell environment and sets a memory ceiling |
| `/opt/nuphos-runtime/codex-login.mjs` | Drives Codex's device-code login in an isolated `CODEX_HOME` |
| `/usr/local/bin/nuphos-sync-skills` | Fetches the workspace's skill bundle at startup and swaps it in atomically |
| `/usr/local/bin/nuphos-seed-codex-auth` | Seeds Codex credentials from a mounted secret, once per credential revision |

Both adapter directories are ahead of the base image's globally installed
copies on `PATH`, so `OPENAB_AGENT_COMMAND` resolves to the patched build.

The layer also installs `git`, `python3`, `build-essential`, database clients,
and the cloud CLIs `kubectl`, `helm`, `aws`, `gcloud`, `tailscale`, `mongosh`,
`hcloud`, `aliyun`, `ve`, `linode-cli` and `zeabur` — the tools Nuphos skills
assume are present.

Everything runs as uid/gid 1000 (`node`) with all capabilities dropped. Nothing
in the image requires root at runtime.

### What is not in the image

No credentials, and no prompts. The agent's system prompt, its MCP servers, its
skills and its per-turn credentials are all delivered at runtime by the backend
over ACP, or fetched at startup. An image is the same for every workspace.

## Building

Two layers, in order. The base comes from the `openab` submodule; the toolset
layer is built on top of it and requires `BASE_IMAGE` to be set — there is no
default, so nothing bakes a registry path into the published image.

```sh
git clone --recurse-submodules https://github.com/zeabur/nuphos-runtime.git
cd nuphos-runtime

docker build -f third_party/openab/Dockerfile.unified --target codex \
  --build-arg OPENAB_BUILD_SHA=$(git -C third_party/openab rev-parse --short=12 HEAD) \
  -t openab-codex-base:local third_party/openab

docker build -f image/Dockerfile \
  --build-arg BASE_IMAGE=openab-codex-base:local \
  --build-arg RUNTIME_PROVIDER=codex \
  -t nuphos-runtime-codex:local image
```

For the Claude Code runtime use `--target claude` and
`RUNTIME_PROVIDER=claude-code`.

Rebuilding the toolset layer alone does not pick up a change to the gateway:
the `openab` binary lives in the base layer, so moving the submodule pointer
only reaches users through a rebuild of both.

## Running one

The image's entrypoint is `openab run -c /etc/openab/config.toml`, so a runtime
needs that config file, a credential for the agent, and a way for the backend
to reach it. Nuphos provisions all three; running one by hand means supplying
them yourself:

- **Config.** See [OpenAB's documentation](https://github.com/openabdev/openab)
  for `config.toml` and the ACP listener.
- **Credentials.** Claude Code uses an OAuth token; Codex uses a device-code
  login (`codex login --device-auth`) whose `auth.json` is then seeded into
  `$CODEX_HOME`. Neither belongs in an image, a command line, or a log.
- **Registration.** A workspace administrator registers the runtime's URL and
  auth key with the backend, which then routes conversations to it.

Self-hosting the whole of Nuphos, including runtimes you run yourself, is
in progress and not yet documented here.

## Versions and tags

The version in `package.json` is the image's version. A release bumps it, tags
the commit `vX.Y.Z`, and publishes both providers from that tag; the `Release`
workflow does all three. Builds are dispatch-only and always run `main`'s
workflow definition against a commit reachable from `main`.

Each release publishes four tags per provider:

| Layer | Semantic tag | Revision tag |
| --- | --- | --- |
| Runtime | `X.Y.Z-claude-code` | `<openab-sha12>-claude-code` |
| Runtime | `X.Y.Z-codex` | `<openab-sha12>-codex` |
| Base | `X.Y.Z-base-claude-code` | `<openab-sha12>-base-claude-code` |
| Base | `X.Y.Z-base-codex` | `<openab-sha12>-base-codex` |

The revision tag names the `openab` commit the image was built from, so a
running container maps back to a gateway revision. Both tags point at the same
manifest.

Nuphos pins runtimes by immutable digest, never by tag:

```text
ghcr.io/zeabur/nuphos-openab-runtime@sha256:...
```

Publishing an image rolls nothing out. Each runtime is moved to a new digest
deliberately.

## Relationship to zeabur/openab

[`zeabur/openab`](https://github.com/zeabur/openab) is a fork of
[`openabdev/openab`](https://github.com/openabdev/openab), carried here as the
`third_party/openab` submodule and pinned to an exact commit. It supplies the
gateway binary and `Dockerfile.unified`, which builds the per-agent base
targets. This repository adds the Nuphos layer on top and owns the published
images. Fixes to the gateway or the ACP pool belong upstream or in the fork,
not here.

## Development

```sh
npm test                    # adapter and helper unit tests
```

The smoke tests exercise the real pinned adapters against an offline Codex App
Server fixture, so they need the adapter installed first:

```sh
npm ci --ignore-scripts --prefix image/codex-acp
node test/codex-acp-smoke.mjs image/codex-acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js
```

CI runs all of them, and builds both layers, on every pull request.

## Licence

Apache-2.0 — see [LICENSE](LICENSE).

The images built from this repository bundle third-party software under its own
licences, including software that is not open source: `@anthropic-ai/claude-code`
and the Claude Agent SDK are distributed under Anthropic's commercial terms.
[NOTICE](NOTICE) lists what is included and under what terms. Nuphos and Zeabur
are not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI.
