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
# data/live.json of every release is a link to /var/www/ladoga/live/live.json, written every hour by the collector
# scripts/live/fetch_live.py (systemd ladoga-live.timer, installed and kept up to date by this script).
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
else
  git -C "$SRC" fetch --quiet --depth 1 origin "$BRANCH"
  git -C "$SRC" reset --quiet --hard FETCH_HEAD
fi
# site/ is the site; scripts/live/ the collectors of data/live.json (hourly: lake level, water temperature, МЧС) and
# data/reports.json (daily timer: forum and Telegram reports, incidents, official news); scripts/logs/ the receiver
# of the phones' work log.
git -C "$SRC" sparse-checkout set site scripts/live scripts/logs
echo "server has $(git -C "$SRC" rev-parse --short HEAD)"
link=()
[[ -e "$BASE/current" ]] && link=(--link-dest="$(readlink -f "$BASE/current")")
rsync -a --delete "${link[@]}" --exclude index.template.html --exclude styles.old.css --chmod=D755,F644 "$SRC/site/" "$BASE/releases/$STAMP/"
# The live data lives outside the releases (the collector rewrites it every hour): each release points at it.
install -d -m 755 "$BASE/live"
ln -sfn "$BASE/live/live.json" "$BASE/releases/$STAMP/data/live.json"
# reports.json only grows (fresh reports are added, never replaced): it lives outside the releases too.
[[ -s "$BASE/live/reports.json" ]] || cp "$SRC/site/data/reports.json" "$BASE/live/reports.json"
ln -sfn "$BASE/live/reports.json" "$BASE/releases/$STAMP/data/reports.json"
ln -sfn "releases/$STAMP" "$BASE/current.new"
mv -T "$BASE/current.new" "$BASE/current"
ls -1dt "$BASE"/releases/* | tail -n +4 | xargs -r rm -rf
# The collector: an unprivileged user, the systemd unit and timer from scripts/live (refreshed when they change).
if [[ -f "$SRC/scripts/live/fetch_live.py" ]]; then
  id ladoga-live >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ladoga-live
  chown ladoga-live:ladoga-live "$BASE/live"
  changed=0
  for unit in ladoga-live.service ladoga-live.timer; do
    if ! cmp -s "$SRC/scripts/live/$unit" "/etc/systemd/system/$unit"; then install -m 644 "$SRC/scripts/live/$unit" /etc/systemd/system/; changed=1; fi
  done
  if [[ $changed == 1 ]]; then systemctl daemon-reload; fi
  systemctl enable --now --quiet ladoga-live.timer
  if [[ ! -s "$BASE/live/live.json" ]]; then systemctl start --no-block ladoga-live.service; echo "collector: first run started"; fi
  echo "collector: $(systemctl is-active ladoga-live.timer) timer, next $(systemctl show ladoga-live.timer -p NextElapseUSecRealtime --value)"
fi
# The reports collector (daily timer; it decides itself when the forums are due: every 3 days in season, 5 otherwise).
if [[ -f "$SRC/scripts/live/fetch_reports.py" && -f "$SRC/scripts/live/ladoga-reports.timer" ]]; then
  chown ladoga-live:ladoga-live "$BASE/live/reports.json" 2>/dev/null || true
  changed=0
  for unit in ladoga-reports.service ladoga-reports.timer; do
    if ! cmp -s "$SRC/scripts/live/$unit" "/etc/systemd/system/$unit"; then install -m 644 "$SRC/scripts/live/$unit" /etc/systemd/system/; changed=1; fi
  done
  if [[ $changed == 1 ]]; then systemctl daemon-reload; fi
  systemctl enable --now --quiet ladoga-reports.timer
  if [[ ! -s "$BASE/live/reports_state.json" ]]; then systemctl start --no-block ladoga-reports.service; echo "reports: first run started"; fi
  echo "reports: $(systemctl is-active ladoga-reports.timer) timer, next $(systemctl show ladoga-reports.timer -p NextElapseUSecRealtime --value)"
fi
# The work log receiver: listens on 127.0.0.1:8791 only; the phones reach it once Caddy has the /ladoga/api/ route
# (scripts/logs/enable_caddy_route.sh — a separate step, the web server is shared with «СПб Топливо»).
if [[ -f "$SRC/scripts/logs/ladoga-logs.service" ]]; then
  if ! cmp -s "$SRC/scripts/logs/ladoga-logs.service" /etc/systemd/system/ladoga-logs.service; then
    install -m 644 "$SRC/scripts/logs/ladoga-logs.service" /etc/systemd/system/; systemctl daemon-reload
  fi
  systemctl enable --quiet ladoga-logs.service; systemctl restart ladoga-logs.service  # the new code of the receiver
  echo "log receiver: $(systemctl is-active ladoga-logs.service)"
fi
echo "now serving $(readlink "$BASE/current"): $(find "$BASE/current/" -type f | wc -l) files, $(du -sh "$BASE/current/" | cut -f1)"
REMOTE

code="$(curl -s -o /dev/null -w '%{http_code}' "https://$IP/ladoga/" || true)"
echo "https://$IP/ladoga/ answers $code"
