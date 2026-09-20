#!/usr/bin/env bash
set -euo pipefail

: "${NUPHOS_RUNTIME_SKILLS_URL:?runtime skills URL is unavailable}"
: "${NUPHOS_RUNTIME_SKILLS_TOKEN:?runtime skills credential is unavailable}"

umask 077
runtime_workspace=${NUPHOS_RUNTIME_WORKSPACE:-/workspace}
claude_dir="$runtime_workspace/.claude"
mkdir -p "$claude_dir"
tmp_dir=$(mktemp -d "$claude_dir/.skills-sync.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT
bundle="$tmp_dir/bundle.json"
curl_config="$tmp_dir/curl.conf"
staging="$tmp_dir/skills"
mkdir "$staging"

{
  printf 'silent\nshow-error\nfail-with-body\nconnect-timeout = 10\nmax-time = 120\n'
  printf 'url = "%s"\n' "$NUPHOS_RUNTIME_SKILLS_URL"
  printf 'header = "Authorization: Bearer %s"\n' "$NUPHOS_RUNTIME_SKILLS_TOKEN"
  printf 'output = "%s"\n' "$bundle"
} >"$curl_config"
chmod 600 "$curl_config"
curl --config "$curl_config"

jq -e '.revision | type == "string"' "$bundle" >/dev/null
revision=$(jq -er '.revision' "$bundle")
revision_file="$claude_dir/.skills-revision"

# The provisioner re-runs this on every reconcile of a live runtime, so the
# usual outcome is that the bundle already on disk is the one being fetched.
# Reinstalling it would be pure churn under a running agent, so stop here.
if [[ -d $claude_dir/skills && -r $revision_file && $(cat "$revision_file") == "$revision" ]]; then
  exit 0
fi

jq -ce '.files[]' "$bundle" | while IFS= read -r file; do
  relative=$(printf '%s' "$file" | jq -er '.path | select(type == "string" and length > 0)')
  case "$relative" in
    /*|*..*|*//*|*\\*) printf 'unsafe runtime skill path: %s\n' "$relative" >&2; exit 1 ;;
  esac
  destination="$staging/$relative"
  mkdir -p "$(dirname "$destination")"
  printf '%s' "$file" | jq -er '.contentBase64' | base64 --decode >"$destination"
  if [[ $(printf '%s' "$file" | jq -r '.executable == true') == true ]]; then
    chmod 755 "$destination"
  else
    chmod 644 "$destination"
  fi
done

# Swap the tree in through a symlink rather than `rm -rf` + `mv`. This script
# also runs against a pod that is already serving conversations — the
# provisioner re-runs it there instead of recreating the pod when a team edits
# a skill — and deleting the directory first would leave an agent process that
# happened to start in that instant with no skills at all. Replacing a symlink
# is a single rename, so a reader sees either the whole old tree or the whole
# new one.
#
# The destination carries the pid as well as the revision so that it can never
# be the directory `skills` currently points at: nothing live is removed to
# make room, whatever state the marker above is in.
installed="$claude_dir/skills.$revision.$$"
mv "$staging" "$installed"
ln -sfn "$(basename "$installed")" "$tmp_dir/skills.link"
mv -T "$tmp_dir/skills.link" "$claude_dir/skills"

# settings.json is the agent's, not a skill: it sits beside the tree rather
# than inside it. Copied rather than linked so it survives the swap above.
if [[ -r $installed/_runtime/settings.json ]]; then
  cp "$installed/_runtime/settings.json" "$claude_dir/.settings.json.incoming"
  mv -f "$claude_dir/.settings.json.incoming" "$claude_dir/settings.json"
fi

# Records what is installed so the provisioner can tell whether a push landed.
printf '%s' "$revision" >"$revision_file.incoming"
mv -f "$revision_file.incoming" "$revision_file"

# Retire the trees no longer pointed at.
find "$claude_dir" -maxdepth 1 -type d -name 'skills.*' ! -name "$(basename "$installed")" -exec rm -rf {} +
