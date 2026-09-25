#!/usr/bin/env bash
# One-time step, only with the owner's consent: Caddy on the shared VPS (it also serves «СПб Топливо») gets one route,
#   handle /ladoga/api/* { reverse_proxy 127.0.0.1:8791 }
# for the work log receiver (ladoga-logs.service). The change is checked by `caddy validate` before a graceful
# reload; afterwards both sites must still answer, otherwise the saved Caddyfile goes back at once.
# The same block must also be added to server/Caddyfile of the spb-fuel-intelligence repository — its
# `remote.sh setup` rewrites /etc/caddy/Caddyfile and would drop the route.
#
#   scripts/logs/enable_caddy_route.sh [IP]
set -euo pipefail
IP="${1:-195.133.61.136}"
KEY="${LADOGA_SSH_KEY:-$HOME/.ssh/spbfi_club_ed25519}"
ssh -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$HOME/.ssh/known_hosts" "root@$IP" 'bash -s' <<'REMOTE'
set -euo pipefail
CF=/etc/caddy/Caddyfile
if grep -q 'handle /ladoga/api/\*' "$CF"; then echo "route already there"; exit 0; fi
cp -p "$CF" "$CF.before-ladoga-api"
python3 - "$CF" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
i = s.find("handle_path /ladoga/*")
assert i >= 0, "no /ladoga/ block"
line_start = s.rfind("\n", 0, i) + 1
indent = s[line_start:i]
block = (f"{indent}# Work log of the Ladoga app (ladoga-logs.service, scripts/logs in ladoga-fishing-map).\n"
         f"{indent}handle /ladoga/api/* {{\n{indent}\treverse_proxy 127.0.0.1:8791\n{indent}}}\n")
open(p, "w", encoding="utf-8").write(s[:line_start] + block + s[line_start:])
PY
restore() { cp -p "$CF.before-ladoga-api" "$CF"; systemctl reload caddy || true; echo "RESTORED the previous Caddyfile" >&2; exit 1; }
caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1 || restore
systemctl reload caddy || restore
sleep 2
ladoga=$(curl -s -o /dev/null -w '%{http_code}' -k https://127.0.0.1/ladoga/ -H "Host: $(hostname -I | awk '{print $1}')" || true)
fuel=$(curl -s -o /dev/null -w '%{http_code}' -k https://127.0.0.1/ -H "Host: $(hostname -I | awk '{print $1}')" || true)
api=$(curl -s -o /dev/null -w '%{http_code}' -k https://127.0.0.1/ladoga/api/health -H "Host: $(hostname -I | awk '{print $1}')" || true)
echo "ladoga $ladoga, fuel $fuel, api $api"
[[ "$ladoga" == 200 && "$fuel" =~ ^(200|301|302|308)$ ]] || restore
REMOTE
