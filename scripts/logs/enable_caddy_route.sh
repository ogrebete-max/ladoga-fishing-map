#!/usr/bin/env bash
# One-time step, with the owner's consent (given 25.09.2026: «включай всё»): Caddy on the shared VPS (it also serves
# «СПб Топливо») gets two routes to the work log receiver (ladoga-logs.service, 127.0.0.1:8791):
#   handle /ladoga/api/* { reverse_proxy 127.0.0.1:8791 }   — the Ladoga map (site/log.js)
#   handle /applog/*     { reverse_proxy 127.0.0.1:8791 }   — any other app of the owner (СПб Топливо: /applog/fuel/…)
# The change is checked by `caddy validate` before a graceful reload; afterwards both sites must still answer,
# otherwise the saved Caddyfile goes back at once. The same blocks are in server/Caddyfile of the
# spb-fuel-intelligence repository (its `remote.sh setup` rewrites /etc/caddy/Caddyfile).
#
#   scripts/logs/enable_caddy_route.sh [IP]
set -euo pipefail
IP="${1:-195.133.61.136}"
KEY="${LADOGA_SSH_KEY:-$HOME/.ssh/spbfi_club_ed25519}"
ssh -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$HOME/.ssh/known_hosts" "root@$IP" "bash -s -- $IP" <<'REMOTE'
set -euo pipefail
IP="$1"
CF=/etc/caddy/Caddyfile
if grep -q 'handle /ladoga/api/' "$CF" && grep -q 'handle /applog/' "$CF"; then echo "routes already there"; exit 0; fi
cp -p "$CF" "$CF.before-applog"
python3 - "$CF" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
i = s.find("handle_path /ladoga/*")
assert i >= 0, "no /ladoga/ block"
line_start = s.rfind("\n", 0, i) + 1
ind = s[line_start:i]
nl, tab = "\n", "\t"
block = ""
if "handle /ladoga/api/" not in s:
    block += (ind + "# Work log of the owner's apps (ladoga-logs.service, scripts/logs in ladoga-fishing-map):" + nl
              + ind + "# the Ladoga map, and under /applog/<app>/ any other app (СПб Топливо: /applog/fuel/log)." + nl
              + ind + "handle /ladoga/api/* {" + nl + ind + tab + "reverse_proxy 127.0.0.1:8791" + nl + ind + "}" + nl)
if "handle /applog/" not in s:
    block += ind + "handle /applog/* {" + nl + ind + tab + "reverse_proxy 127.0.0.1:8791" + nl + ind + "}" + nl
open(p, "w", encoding="utf-8").write(s[:line_start] + block + s[line_start:])
PY
restore() { cp -p "$CF.before-applog" "$CF"; systemctl reload caddy || true; echo "RESTORED the previous Caddyfile" >&2; exit 1; }
caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1 || restore
systemctl reload caddy || restore
sleep 3
# Through the public address: a request to 127.0.0.1 carries no name, and Caddy has no certificate for it.
code() { curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$IP$1" || true; }
ladoga=$(code /ladoga/) fuel=$(code /) api=$(code /ladoga/api/health) applog=$(code /applog/health)
echo "ladoga $ladoga, fuel $fuel, ladoga api $api, applog $applog"
[[ "$ladoga" == 200 && "$fuel" =~ ^(200|301|302|308)$ && "$api" == 200 && "$applog" == 200 ]] || restore
echo "routes on"
REMOTE
