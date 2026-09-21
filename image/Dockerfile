# syntax=docker/dockerfile:1.19

# The Nuphos toolset layer: the agent CLIs that the skills expect to find, on
# top of a provider base built from third_party/openab/Dockerfile.unified.
# See the repository README for the two-layer build.
#
# Runs as uid/gid 1000 (node) with all caps dropped — everything here must be
# usable without root.

# No default: a baked-in default would publish the operator's registry path in
# the image config, and every caller already knows which base it is layering on.
ARG BASE_IMAGE
FROM ${BASE_IMAGE:?BASE_IMAGE-build-arg-is-required-see-the-README}

# claude-code layers on a --target claude base, codex on a --target codex base.
ARG RUNTIME_PROVIDER=claude-code

ARG ZEABUR_CLI_VERSION=v0.16.0
ARG HCLOUD_VERSION=v1.66.0
ARG VOLCENGINE_CLI_VERSION=1.0.52
ARG ALIYUN_CLI_VERSION=3.4.11
ARG KUBECTL_VERSION=v1.36.0
ARG HELM_VERSION=v3.18.4
ARG AWSCLI_VERSION=2.34.45
ARG GCLOUD_VERSION=567.0.0-0
ARG LINODE_CLI_VERSION=5.67.0
ARG MONGOSH_VERSION=2.8.3
ARG TAILSCALE_VERSION=1.98.10

ENV DEBIAN_FRONTEND=noninteractive

USER root

COPY --chmod=755 sync-skills.sh /usr/local/bin/nuphos-sync-skills
COPY --chmod=755 seed-codex-auth.sh /usr/local/bin/nuphos-seed-codex-auth
COPY runtime-defaults.mjs mcp-bridge-config.mjs /opt/
# Sourced via BASH_ENV, so it is read, never executed.
COPY --chmod=644 runtime-guard.sh /opt/nuphos-runtime/runtime-guard.sh
COPY codex-login.mjs mcp-http-bridge.mjs /opt/nuphos-runtime/
# COPY --chmod also affects newly created destination directories.
# Runtime helpers must be traversable by the non-root init and agent containers.
RUN chmod 755 /opt/nuphos-runtime \
 && chmod 644 /opt/nuphos-runtime/runtime-guard.sh /opt/nuphos-runtime/codex-login.mjs \
      /opt/nuphos-runtime/mcp-http-bridge.mjs

# Pin the SDK used by the adapter so the model picker lists current models and
# retains the idle wakeup fixes introduced in SDK 0.3.238.
# The committed lockfile is the integrity boundary for this build step.
ARG CLAUDE_AGENT_SDK_VERSION=0.3.261
COPY claude-agent-acp/package.json claude-agent-acp/package-lock.json \
     claude-agent-acp/patch-adapter.mjs claude-agent-acp/turn-completion.mjs \
     /opt/nuphos-claude-agent-acp/
RUN if [ "${RUNTIME_PROVIDER}" = claude-code ]; then \
    cd /opt/nuphos-claude-agent-acp \
 && npm ci --omit=dev --ignore-scripts \
 && test "$(node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version")" = \
      "${CLAUDE_AGENT_SDK_VERSION}" \
 && node patch-adapter.mjs node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js; fi

COPY codex-acp/package.json codex-acp/package-lock.json \
     codex-acp/patch-adapter.mjs codex-acp/session-config.mjs codex-acp/steering.mjs /opt/nuphos-codex-acp/
RUN if [ "${RUNTIME_PROVIDER}" = codex ]; then \
    cd /opt/nuphos-codex-acp \
 && npm ci --omit=dev --ignore-scripts \
 && node patch-adapter.mjs node_modules/@agentclientprotocol/codex-acp/dist/index.js; fi

ENV PATH="/opt/nuphos-codex-acp/node_modules/.bin:/opt/nuphos-claude-agent-acp/node_modules/.bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg jq unzip \
        bash coreutils util-linux procps acct \
        git openssh-client \
        build-essential \
        python3 python3-pip python3-venv \
        postgresql-client mariadb-client \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
        | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
        > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        google-cloud-cli=${GCLOUD_VERSION} \
        google-cloud-cli-gke-gcloud-auth-plugin=${GCLOUD_VERSION} \
    && rm -rf /var/lib/apt/lists/* \
    && jq --version && gcloud --version

RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
 && ln -sf /usr/bin/pip3   /usr/local/bin/pip

RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) aws_arch=x86_64 ;; arm64) aws_arch=aarch64 ;; esac \
 && curl -fsSL -o /tmp/awscli.zip "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}-${AWSCLI_VERSION}.zip" \
 && unzip -q /tmp/awscli.zip -d /tmp \
 && /tmp/aws/install \
 && rm -rf /tmp/awscli.zip /tmp/aws \
 && aws --version

RUN pip3 install --no-cache-dir --break-system-packages "linode-cli==${LINODE_CLI_VERSION}" \
 && linode-cli --version

RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) mongo_arch=x64 ;; arm64) mongo_arch=arm64 ;; esac \
 && curl -fsSL "https://downloads.mongodb.com/compass/mongosh-${MONGOSH_VERSION}-linux-${mongo_arch}.tgz" \
    | tar -xz -C /usr/local/bin --strip-components=2 \
      "mongosh-${MONGOSH_VERSION}-linux-${mongo_arch}/bin" \
 && mongosh --version

RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL "https://github.com/hetznercloud/cli/releases/download/${HCLOUD_VERSION}/hcloud-linux-${arch}.tar.gz" \
    | tar -xz -C /usr/local/bin hcloud \
 && hcloud version

RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL "https://github.com/volcengine/volcengine-cli/releases/download/v${VOLCENGINE_CLI_VERSION}/volcengine-cli_${VOLCENGINE_CLI_VERSION}_linux_${arch}.tar.gz" \
    | tar -xz -C /usr/local/bin ve \
 && ve --version

RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL "https://github.com/aliyun/aliyun-cli/releases/download/v${ALIYUN_CLI_VERSION}/aliyun-cli-linux-${ALIYUN_CLI_VERSION}-${arch}.tgz" \
    | tar -xz -C /usr/local/bin aliyun \
 && aliyun version

RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && kubectl version --client \
 && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz" \
    | tar -xz -C /usr/local/bin --strip-components=1 "linux-${arch}/helm" \
 && helm version --short

# tailscaled runs in userspace-networking mode here, so no TUN/NET_ADMIN needed.
RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${arch}.tgz" \
    | tar -xz -C /usr/local/bin --strip-components=1 \
      "tailscale_${TAILSCALE_VERSION}_${arch}/tailscale" \
      "tailscale_${TAILSCALE_VERSION}_${arch}/tailscaled" \
 && tailscale version

# Zeabur CLI, from the vendor's public CDN.
RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL "https://cdn.zeabur.com/cli/${ZEABUR_CLI_VERSION}/zeabur-linux-${arch}" \
    -o /usr/local/bin/zeabur \
 && chmod +x /usr/local/bin/zeabur \
 && zeabur version

# openab exits when the file its CMD names is missing, so the image carries one
# and a bare `docker run` needs no volume. A mount at /etc/openab/config.toml
# replaces this file; openab reads that single path and merges nothing.
COPY openab-config.claude-code.toml openab-config.codex.toml /tmp/nuphos-config/
RUN install -d -m 755 /etc/openab \
 && install -m 644 "/tmp/nuphos-config/openab-config.${RUNTIME_PROVIDER}.toml" \
      /etc/openab/config.toml \
 && rm -rf /tmp/nuphos-config

# Version checks above run as root and drop state dirs into $HOME.
RUN chown -R node:node /home/node

USER node
RUN test -x /opt/nuphos-runtime \
 && test -r /opt/nuphos-runtime/mcp-http-bridge.mjs \
 && test -r /opt/nuphos-runtime/runtime-guard.sh \
 && test -r /opt/nuphos-runtime/codex-login.mjs \
 && test -r /etc/openab/config.toml
