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
   `@agentclientprotocol/claude-agent-acp` with the Claude Code CLI that ships
   inside the Claude Agent SDK; for `codex`, `@openai/codex` with
   `@agentclientprotocol/codex-acp`. The adapter translates ACP into whatever
   the CLI actually speaks. Each image carries exactly one copy of each.
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
| `/usr/local/bin/nuphos-runtime-start` | The entrypoint: resolves the password (environment, else the stored one, else a new one), derives the operator key from it when none is set, lays out `/workspace` the way a provisioned pod does, then becomes openab |
| `/etc/openab/config.toml` | The gateway config openab reads, so the container starts with nothing mounted; a mount at this path replaces it |
| `/opt/runtime-defaults.mjs` | Applies a model, reasoning effort and fast-mode default to a new session |
| `/opt/nuphos-runtime/mcp-http-bridge.mjs` | Relays a stdio MCP server to a bearer-authenticated HTTP endpoint, re-reading the token per request |
| `/opt/nuphos-runtime/runtime-guard.sh` | Sourced via `BASH_ENV`; refreshes per-turn credentials into the shell environment and sets a memory ceiling |
| `/opt/nuphos-runtime/panel-job.mjs` | The `panel` job OpenAB runs for `_openab/runtime/job`: writes the panel runner, script and params into a fresh directory and runs `node runner.mjs <dir>`, passing stdout and the exit code through |
| `/opt/nuphos-runtime/codex-login.mjs` | Drives Codex's device-code login in an isolated `CODEX_HOME` |
| `/opt/nuphos-runtime/claude-login.mjs` | Drives `claude auth login`: reports the authorize URL, passes back the code the user pastes, and leaves the credential in `~/.claude` |
| `/usr/local/bin/nuphos-sync-skills` | Fetches the workspace's skill bundle and swaps it in atomically — pushed by the provisioner for a managed pod, run per session by `runtime-defaults.mjs` for a self-hosted one |
| `/usr/local/bin/nuphos-seed-codex-auth` | Seeds Codex credentials from a mounted secret, once per credential revision |

`OPENAB_AGENT_COMMAND` names the patched adapter, and `claude` on `PATH` is the
same native CLI the Claude adapter runs.

### Command-line tools

The image ships only what the agent loop and the skills use on every turn:
`git`, `gh`, `jq`, `ripgrep`, `curl`, `python3` (with `venv`), `kubectl` and
`zeabur`. Every other tool a skill may reach for is a small shim on `PATH` that
installs the pinned release the first time it runs and then hands over to it, so
`aws s3 ls` works as it always did — the first call just takes longer and needs
network access.

| Tool | Commands |
| --- | --- |
| AWS CLI v2 | `aws` |
| Google Cloud CLI | `gcloud`, `gsutil`, `bq`, and `gke-gcloud-auth-plugin` |
| mongosh | `mongosh` |
| PostgreSQL 17 client | `psql`, `pg_dump`, `pg_dumpall`, `pg_restore`, `pg_isready` |
| MariaDB client | `mariadb`/`mysql`, `mariadb-dump`/`mysqldump`, `mariadb-admin`/`mysqladmin` |
| Hetzner, Volcengine, Aliyun, Linode | `hcloud`, `ve`, `aliyun`, `linode-cli` |
| Helm, Tailscale | `helm`, `tailscale`, `tailscaled` |
| C/C++ toolchain | `gcc`, `g++`, `cc`, `c++`, `make`, binutils |

Versions, download URLs and SHA-256 checksums are pinned in
[`image/tools/manifest.json`](image/tools/manifest.json); a download that does not
match is discarded. The Debian packages (the database clients and the toolchain)
are fetched with `apt-get` as the unprivileged user and verified against the
archive's signatures, then unpacked rather than installed. `nuphos-tools list`
shows what is installed, and `nuphos-tools install <tool>` (or `--all`) fetches
ahead of time.

Tools install under `/home/node/.nuphos-runtime/tools` (override with
`NUPHOS_TOOLS_DIR`), so they last exactly as long as the home directory does:

- **Nuphos-provisioned pods** mount a persistent volume at `/home/node`, so a
  tool is fetched once per runtime and survives restarts and image upgrades. An
  image that pins a newer version installs it on first use and removes the old one.
- **A self-hosted container** keeps them across restarts only with a volume at
  `/home/node` (see [Running one](#running-one)). Without one, each new container
  fetches a tool again the first time it is used.

Concurrent first calls wait on a per-tool lock, so a tool is only ever fetched
once. Progress goes to stderr; stdout stays the tool's own.

Everything runs as uid/gid 1000 (`node`) with all capabilities dropped. Nothing
in the image requires root at runtime.

### What is not in the image

No credentials, and no prompts. The agent's system prompt, its MCP servers, its
skills and its per-turn credentials are all delivered at runtime by the backend
over ACP, or fetched at startup. An image is the same for every workspace.

## Building

Two builds, in order. The base is the gateway, built from the `openab`
submodule; the runtime image takes only the `openab` binary from it and builds
everything else on `node:22-trixie-slim`. `BASE_IMAGE` must be set — there is no
default, so nothing bakes a registry path into the published image.

```sh
git clone --recurse-submodules https://github.com/zeabur/nuphos-runtime.git
cd nuphos-runtime

docker build -f third_party/openab/Dockerfile.unified --target agentcore \
  -t openab-base:local third_party/openab

docker build -f image/Dockerfile \
  --build-arg BASE_IMAGE=openab-base:local \
  --build-arg OPENAB_BUILD_SHA=$(git -C third_party/openab rev-parse --short=12 HEAD) \
  --build-arg RUNTIME_PROVIDER=codex \
  -t nuphos-runtime-codex:local image
```

For the Claude Code runtime use `RUNTIME_PROVIDER=claude-code`. Any image built
from `Dockerfile.unified` works as `BASE_IMAGE`, including a published
`X.Y.Z-base-<provider>` tag.

Rebuilding the runtime image alone does not pick up a change to the gateway:
the `openab` binary comes from the base, so moving the submodule pointer only
reaches users through a rebuild of both.

## Running one

A runtime needs nothing set. Give it a persistent home and start it:

```sh
docker run -d --name nuphos-runtime -p 8080:8080 \
  -v nuphos-runtime-home:/home/node \
  ghcr.io/zeabur/nuphos-runtime:0.0.12-codex
```

Use `0.0.12-claude-code` for a Claude Code runtime.

On first boot the runtime generates its admin password, stores it in
`/home/node/.nuphos-runtime/auth-key` (mode `0600`), and prints it once:

```text
Generated runtime password (stored in /home/node/.nuphos-runtime/auth-key): <password> — enter it in Nuphos when connecting this runtime. …
```

You paste it into Nuphos when you connect the runtime. Read it back from the
container's logs (`docker logs nuphos-runtime`, or the service's logs on Zeabur),
or from the file itself:

```sh
docker exec nuphos-runtime cat /home/node/.nuphos-runtime/auth-key
```

Later boots reuse the stored password and never print it again.
**`/home/node` must be persistent** — mount a volume there, as above. Without
one the file is lost with the container, and every restart generates a new
password that each Nuphos workspace connected to the runtime has to be given
again. If the file goes missing from a home that has run a runtime before, the
log says so with a `WARNING`. `OPENAB_ACP_AUTH_KEY_FILE` moves the file.

To choose the password yourself, set `OPENAB_ACP_AUTH_KEY`; it always wins over
the stored one, and nothing is generated or written. It must be at least 32
characters, using only letters, digits and ``! # $ % & ' * + - . ^ _ ` | ~`` — it
travels in a WebSocket header, so spaces, quotes, `/`, `=` and `:` cannot.
`openssl rand -hex 32` always qualifies. A password under 32 characters, from
either source, stops the container at startup with an error.

The volume also keeps the account the runtime signs in with
(`/home/node/.claude` for Claude Code, `/home/node/.codex` for Codex) and the
command-line tools it installs on first use across container replacement.

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
`OPENAB_AGENT_COMMAND`, which each variant's image sets. See
[OpenAB's documentation](https://github.com/openabdev/openab) for the rest of
`config.toml`.

### What each provider needs beyond the password

Each runtime owns its own login. Nuphos never stores the account and never sends
one to a runtime it did not provision; it only shows what the runtime reports.

| Variant | Sign in on the host | Credential |
| --- | --- | --- |
| `claude-code` | `docker exec -it nuphos-runtime claude auth login` (or run `claude` and use `/login`) | `/home/node/.claude/.credentials.json` |
| `codex` | `docker exec -it nuphos-runtime codex login --device-auth` | `/home/node/.codex/auth.json` |

You can also sign in from the app once the runtime is connected (see below). Either
way the credential is written inside the container, so mount the `/home/node` volume
from the quick start to keep it.

For Claude Code there is a third option: set `CLAUDE_CODE_OAUTH_TOKEN` on the
container yourself, for example to a token from `claude setup-token`. That token
takes precedence over any stored login, so the runtime then turns off sign-in from
the app and does not report a sign-in state.

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

To rotate the password, change `OPENAB_ACP_AUTH_KEY` (or replace the stored file
and restart) and then update it in the runtime's settings. Removing a runtime from Nuphos does not revoke its password.

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

#### Upgrading a Claude Code runtime from 0.0.12 or earlier

Nuphos used to store a pasted Claude Code token and send it with every session. It
no longer does. Before upgrading Nuphos, sign the runtime in with one of the options
above, or its sessions will fail with "sign in required".

### Signing in from the app

Once a runtime is connected, press **Sign in** on its card. The app runs the
provider's own sign-in inside the container, so you don't need a shell on the host:

- **Codex:** the app shows a device code to enter on the ChatGPT page.
- **Claude Code:** the app opens Claude's sign-in page. After you approve, that page
  shows a code; paste it into the app. The code reaches `claude auth login` in the
  container through the operator channel (`_openab/runtime/login/input`).

The credential the flow creates stays in the container. Only the device code, the
authorize link, and the pasted code cross the wire. Afterwards the runtime reports
whether it holds a credential, so the card stops asking. Keep the `/home/node`
volume, or the sign-in is lost with the container. Claude Code images up to v0.0.12
ship a gateway that cannot relay the pasted code; on those the app reports that and
you sign in on the host instead.

The published images carry the two settings that enable this: the sign-in command
and the credential path. A hand-built image has to pass them itself:

```sh
# Codex
--build-arg 'RUNTIME_LOGIN_COMMAND=node /opt/nuphos-runtime/codex-login.mjs --install' \
--build-arg RUNTIME_AUTH_FILE=/home/node/.codex/auth.json
# Claude Code
--build-arg 'RUNTIME_LOGIN_COMMAND=node /opt/nuphos-runtime/claude-login.mjs' \
--build-arg RUNTIME_AUTH_FILE=/home/node/.claude/.credentials.json
```

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
| Base (gateway only) | `X.Y.Z-base-claude-code` | `<openab-sha12>-base-claude-code` |
| Base (gateway only) | `X.Y.Z-base-codex` | `<openab-sha12>-base-codex` |

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
gateway binary and `Dockerfile.unified`, whose `agentcore` target is the
base the runtime image takes it from. This repository adds the Nuphos layer on top and owns the published
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

CI runs all of them on every pull request, builds both runtime images on a
published gateway base, and smoke-tests them, including a first-use install of
an archive tool, a Debian-package tool and the C toolchain. The gateway base is
a Rust build, so it is built only when an image is published.

## Licence

Apache-2.0 — see [LICENSE](LICENSE).

The images built from this repository bundle third-party software under its own
licences, including software that is not open source: `@anthropic-ai/claude-code`
and the Claude Agent SDK are distributed under Anthropic's commercial terms.
[NOTICE](NOTICE) lists what is included and under what terms. Nuphos and Zeabur
are not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI.
