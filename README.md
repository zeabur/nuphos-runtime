# Nuphos Runtime

The container image that runs a coding agent for [Nuphos](https://nuphos.ai).

A Nuphos runtime is a long-lived container with one coding agent inside it —
either **Claude Code** or **Codex** — reachable over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). The Nuphos
backend does not run the agent itself; it opens an ACP session against a
runtime and streams the conversation through it. This repository builds the
image those runtimes run.

Images are published to `ghcr.io/zeabur/nuphos-runtime`.

## What is in the image

Three things, in layers:

1. **The OpenAB gateway.** [`openab`](https://github.com/openabdev/openab) is
   the process that owns the container: it accepts ACP over the network,
   supervises the agent, and keeps sessions alive across agent restarts. A
   short start script prepares the container and then becomes openab.
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
| `/usr/local/bin/nuphos-runtime-start` | The entrypoint: derives the operator key from the password when none is set, lays out `/workspace` the way a provisioned pod does, then becomes openab |
| `/etc/openab/config.toml` | The gateway config openab reads, so the container starts with nothing mounted; a mount at this path replaces it |
| `/opt/runtime-defaults.mjs` | Applies a model, reasoning effort and fast-mode default to a new session |
| `/opt/nuphos-runtime/mcp-http-bridge.mjs` | Relays a stdio MCP server to a bearer-authenticated HTTP endpoint, re-reading the token per request |
| `/opt/nuphos-runtime/runtime-guard.sh` | Sourced via `BASH_ENV`; refreshes per-turn credentials into the shell environment and sets a memory ceiling |
| `/opt/nuphos-runtime/codex-login.mjs` | Drives Codex's device-code login in an isolated `CODEX_HOME` |
| `/usr/local/bin/nuphos-sync-skills` | Fetches the workspace's skill bundle and swaps it in atomically — pushed by the provisioner for a managed pod, run per session by `runtime-defaults.mjs` for a self-hosted one |
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

A runtime takes one variable: an admin password. Nothing else has to be set.

```sh
docker run -d --name nuphos-runtime -p 8080:8080 \
  -e OPENAB_ACP_AUTH_KEY="$(openssl rand -hex 32)" \
  -v nuphos-runtime-home:/home/node \
  ghcr.io/zeabur/nuphos-runtime:0.0.7-codex
```

Use `0.0.7-claude-code` for a Claude Code runtime. Keep the password: you paste it
into Nuphos when you connect the runtime. It must be at least 32 characters, using
only letters, digits and ``! # $ % & ' * + - . ^ _ ` | ~`` — it travels in a
WebSocket header, so spaces, quotes, `/`, `=` and `:` cannot. `openssl rand -hex 32`
always qualifies.

The volume is optional but recommended. It keeps whatever the runtime holds
across container replacement — for Codex, the account it signs in with.

ACP is then served at `ws://<host>:8080/acp`, and Nuphos connects to it over
**`wss://`** — put TLS in front of the port. Most hosts terminate TLS for you
(Zeabur, for one, gives every service an HTTPS domain), so this is usually
nothing more than using the address they hand you; on a bare VPS, a reverse
proxy such as Caddy does it in one line.

Before pasting the address into Nuphos, open the base URL (`http://<host>:8080/`
or its `https://` equivalent once TLS is in front) in a browser — openab serves
an unauthenticated status page there confirming the runtime is up, its provider,
and its version. It never shows the password, the derived key, or anything else
secret.

The password is the only thing standing in front of an agent that holds your
workspace's cloud credentials, so openab will not serve `/acp` on a routable
address without it, and refuses any upgrade that does not present it (`401`).
Everything else ACP needs is already set in the image. The operator credential
openab uses for runtime-wide status and sign-in is derived from the same
password, by the runtime and by Nuphos alike, so there is no second secret to
set or paste. To turn ACP off entirely, set `OPENAB_ACP_ENABLED=false`.

The image ships a default `/etc/openab/config.toml`, so nothing has to be
mounted for the container to start. openab reads that one path and merges
nothing, so your own file replaces the default outright:

```sh
-v ./config.toml:/etc/openab/config.toml:ro
```

The baked default holds only what is true of the image — the agent's working
directory, its MCP call timeouts, the `BASH_ENV` guard, and for Codex the
containerized `agent-full-access` mode. If you replace it, keep
`working_dir = "/workspace"` under `[agent]`: openab ignores the directory a
client asks for and otherwise runs the agent in `$HOME`, where the team's skills
never land. Anything sized to a particular deployment, such as
`[pool]` capacity or per-tool memory ceilings, is left to whoever knows the
container's limits. The agent command itself is not pinned there: it stays on
`OPENAB_AGENT_COMMAND`, which each variant's base image sets. See
[OpenAB's documentation](https://github.com/openabdev/openab) for the rest of
`config.toml`.

### What each provider needs beyond the password

| Variant | Provider account |
| --- | --- |
| `claude-code` | Nothing to supply. Nuphos delivers the account over the ACP session once the runtime is registered. |
| `codex` | A one-time device sign-in, driven from the app once the runtime is registered — see below. `docker exec -it nuphos-runtime codex login --device-auth` still works if you would rather do it on the host. |

Codex credentials land in `$HOME/.codex`, which is lost when the container is
replaced; mount a volume at `/home/node` to keep them. A Claude Code runtime
needs no volume, because it holds no credential of its own.

### Connecting it to Nuphos

A workspace administrator opens **Settings → Agent → Connect your own** and pastes
two things: the runtime's `wss://` address and the password it was started with.
That is the whole binding. Plain `ws://` is accepted only for an in-cluster `*.svc`
host; anything reached over the internet has to be `wss://`.

Everything else a Nuphos-provisioned pod has always had is already in the image,
so the agent reaches Nuphos' own tools as soon as it is connected — the container
only has to be able to resolve and reach the backend they are served from. The
team's skills arrive the same way: for a runtime it did not provision, the backend
hands each session a short-lived bundle address, and the runtime fetches the bundle
itself.

`GATEWAY_ALLOWED_USERS` is baked as the gateway-wide trusted-sender list, not an ACP
switch. If you also enable Discord, Slack or LINE on the same container, **add**
their sender ids to it rather than replacing the baked value, or those platforms
are denied instead.

To rotate the password, change it on the container and then in the runtime's
settings. Removing a runtime from Nuphos does not revoke its password.

#### Separate operator key

The operator credential is derived from the password unless you set
`OPENAB_ACP_CONTROL_KEY` yourself, in which case the runtime uses yours. Only a
Nuphos-provisioned pod needs that: the provisioner issues both keys from its own
Secret. A self-hosted runtime gains nothing from a second value — anyone holding
the password can already run code in the container through the agent.

#### Upgrading from 0.0.6 or earlier

Those images need more than the password. 0.0.5 and earlier carry none of the ACP
environment, so without `OPENAB_ACP_MCP_SERVERS=true` the agent gets no Nuphos
tools, and without `GATEWAY_ALLOWED_USERS=acp_client` the runtime accepts a session
and then refuses its first prompt. Before 0.0.7 none of them derive the operator
key, so a runtime connected with only its password gets no status and no Codex
sign-in, and none create `/workspace`, so skills never land. Moving to 0.0.7 needs
no change to how the runtime is connected.

### Signing Codex in from the app

Once a Codex runtime is connected, press **Sign in** on its card. The app runs
Codex's device flow inside the container and shows you the code, instead of you
finding a shell on the host. The credential the flow mints stays in the container:
only the device code and the verification link cross the wire, and the runtime
reports afterwards whether it holds a credential, so the card stops asking. Keep
the `/home/node` volume from the quick start, or the sign-in is lost with the
container.

The published Codex image carries the two settings that enable this — the sign-in
command and the path it writes. A hand-built Codex image must pass them itself:

```sh
--build-arg 'RUNTIME_LOGIN_COMMAND=node /opt/nuphos-runtime/codex-login.mjs --install' \
--build-arg RUNTIME_AUTH_FILE=/home/node/.codex/auth.json
```

A Claude Code image sets neither on purpose: its account arrives with the session,
so there is no file to sign in to and none to report on.

Self-hosting the rest of Nuphos is in progress and not documented here.

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
ghcr.io/zeabur/nuphos-runtime@sha256:...
```

Publishing an image rolls nothing out. Each runtime is moved to a new digest
deliberately.

Images published before this repository existed live under the earlier package
name `ghcr.io/zeabur/nuphos-openab-runtime`. That package is retained, read
only, so runtimes pinned to one of its digests keep resolving; everything new
is published here.

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

CI runs all of them on every pull request, and builds the toolset layer. The
provider base is a Rust build of the gateway, so it is built only when an image
is published.

## Licence

Apache-2.0 — see [LICENSE](LICENSE).

The images built from this repository bundle third-party software under its own
licences, including software that is not open source: `@anthropic-ai/claude-code`
and the Claude Agent SDK are distributed under Anthropic's commercial terms.
[NOTICE](NOTICE) lists what is included and under what terms. Nuphos and Zeabur
are not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI.
