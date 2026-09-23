#!/usr/bin/env bash
# Publish site/ on our own server (the VPS of «СПб Топливо», Moscow) at https://<IP>/ladoga/ .
# Run from the repository in Git Bash after committing and pushing:
#
#   scripts/deploy_vps.sh [IP]        (default 195.133.61.136)
#
# Nothing heavy travels from this PC: the server keeps a shallow, sparse clone of the repository with only
# site/ in /var/www/ladoga/src and pulls the pushed commit from GitHub. The new release is built next to the
# current one with rsync --link-dest (unchanged files are hard links), then `current` is switched in one step,
# so a visitor never sees a half-built site. The last three releases stay for a rollback:
#   ssh root@IP 'ls -1dt /var/www/ladoga/releases/*'  and  ln -sfn releases/<one> /var/www/ladoga/current
# Caddy serves /var/www/ladoga/current under /ladoga/ (server/Caddyfile in the spb-fuel-intelligence repo).
# If the repository becomes private, give the server a read-only deploy key and set LADOGA_REPO to the
# git@github.com:… address. LADOGA_SSH_KEY overrides the key (~/.ssh/spbfi_club_ed25519, the club server's own).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IP="${1:-195.133.61.136}"
KEY="${LADOGA_SSH_KEY:-$HOME/.ssh/spbfi_club_ed25519}"
REPO="${LADOGA_REPO:-https://github.com/ogrebete-max/ladoga-fishing-map.git}"
BRANCH=main
# The known_hosts path is given outright: ssh in Git Bash garbles a Cyrillic home folder by itself.
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$HOME/.ssh/known_hosts")
STAMP="$(date -u +%Y%m%d-%H%M%S)"
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# What goes live is exactly what is committed and pushed.
[[ -z "$(git -C "$ROOT" status --porcelain -- site)" ]] || die "site/ has uncommitted changes: commit and push first"
git -C "$ROOT" fetch --quiet origin "$BRANCH"
[[ "$(git -C "$ROOT" rev-parse HEAD)" == "$(git -C "$ROOT" rev-parse "origin/$BRANCH")" ]] || die "push first: HEAD is not origin/$BRANCH"
echo "publishing $(git -C "$ROOT" rev-parse --short HEAD) as release $STAMP"

"${SSH[@]}" "root@$IP" "bash -s -- $STAMP $REPO $BRANCH" <<'REMOTE'
set -euo pipefail
STAMP="$1" REPO="$2" BRANCH="$3"
BASE=/var/www/ladoga SRC=/var/www/ladoga/src
install -d -m 755 "$BASE" "$BASE/releases"
if [[ ! -d "$SRC/.git" ]]; then
  git clone --quiet --depth 1 --filter=blob:none --sparse --branch "$BRANCH" "$REPO" "$SRC"
  git -C "$SRC" sparse-checkout set site
else
  git -C "$SRC" fetch --quiet --depth 1 origin "$BRANCH"
  git -C "$SRC" reset --quiet --hard FETCH_HEAD
fi
echo "server has $(git -C "$SRC" rev-parse --short HEAD)"
link=()
[[ -e "$BASE/current" ]] && link=(--link-dest="$(readlink -f "$BASE/current")")
rsync -a --delete "${link[@]}" --exclude index.template.html --exclude styles.old.css --chmod=D755,F644 "$SRC/site/" "$BASE/releases/$STAMP/"
ln -sfn "releases/$STAMP" "$BASE/current.new"
mv -T "$BASE/current.new" "$BASE/current"
ls -1dt "$BASE"/releases/* | tail -n +4 | xargs -r rm -rf
echo "now serving $(readlink "$BASE/current"): $(find "$BASE/current/" -type f | wc -l) files, $(du -sh "$BASE/current/" | cut -f1)"
REMOTE

code="$(curl -s -o /dev/null -w '%{http_code}' "https://$IP/ladoga/" || true)"
echo "https://$IP/ladoga/ answers $code"
