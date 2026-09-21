#!/bin/sh
# The image's entrypoint. Prepares what a self-hosted container cannot be handed by a
# provisioner, then becomes the command it was given — openab, by default.
set -eu

# Derive the operator key from the password unless one was set. Must match
# `deriveRuntimeControlKey` in the Nuphos backend. A value equal to the password is
# replaced too, because openab discards an operator key equal to the transport key.
if [ -n "${OPENAB_ACP_AUTH_KEY:-}" ]; then
  if [ -z "${OPENAB_ACP_CONTROL_KEY:-}" ] || [ "$OPENAB_ACP_CONTROL_KEY" = "$OPENAB_ACP_AUTH_KEY" ]; then
    # The password reaches node through the environment, never argv, which is
    # readable by anything in the container through /proc.
    OPENAB_ACP_CONTROL_KEY=$(node -e '
      const { createHmac } = require("node:crypto");
      process.stdout.write(
        createHmac("sha256", process.env.OPENAB_ACP_AUTH_KEY)
          .update("nuphos-runtime-control-v1")
          .digest("hex"),
      );
    ')
    export OPENAB_ACP_CONTROL_KEY
  fi
fi

# The workspace layout a provisioned pod's init container builds, so a self-hosted
# runtime's skills land where each agent reads them. Idempotent, and never fatal: a
# workspace that is not writable still lets the runtime chat.
workspace=${NUPHOS_RUNTIME_WORKSPACE:-/workspace}
if mkdir -p "$workspace/.claude" 2>/dev/null; then
  [ -e "$workspace/skills" ] || ln -s .claude/skills "$workspace/skills" 2>/dev/null || true
  # Codex reads its own path. A symlink rather than a second copy, because it
  # deduplicates skills by absolute path and two real copies would double every
  # entry's context cost.
  if mkdir -p "$workspace/.agents" 2>/dev/null; then
    [ -e "$workspace/.agents/skills" ] || ln -s ../.claude/skills "$workspace/.agents/skills" 2>/dev/null || true
  fi
fi

if [ "$#" -eq 0 ]; then
  set -- openab run -c /etc/openab/config.toml
fi
exec "$@"
