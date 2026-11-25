#!/usr/bin/env bash
# Seeds the landing page genes into the Control Plane: 3 genes, 2 species, population "default" 50/50.
# Usage: scripts/seed-landing.sh            (asks for the API token without echoing it)
set -euo pipefail
API=${NATSEL_API:-https://control.natsel.vapnik.de/api}
read -rsp "API token: " T; echo
c() { curl -sf -H "Authorization: Bearer $T" -H 'content-type: application/json' "$@"; }
id() { python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'; }

c -X POST "$API/genes" -d '{"name":"hero.headline","alleles":["Let your product evolve","Stop running experiments"]}' >/dev/null
c -X POST "$API/genes" -d '{"name":"hero.cta","alleles":["Why your project needs it","See why it works (accent)"]}' >/dev/null
c -X POST "$API/genes" -d '{"name":"status.cta","alleles":["Follow on GitHub","Star it on GitHub"]}' >/dev/null
A=$(c -X POST "$API/species" -d '{"name":"landing-a"}' | id)
B=$(c -X POST "$API/species" -d '{"name":"landing-b","parent_id":"'"$A"'","alleles":{"hero.headline":1,"hero.cta":1,"status.cta":1}}' | id)
c -X POST "$API/species/$A/approve" >/dev/null
c -X POST "$API/species/$B/approve" >/dev/null
c -X POST "$API/populations" -d '{"id":"default","name":"Landing visitors"}' >/dev/null
c -X PUT "$API/populations/default/distribution" -d '{"'"$A"'":50,"'"$B"'":50}'
echo; c "$API/pool" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("genes:",len(d["genes"]),"species:",d["species"],"orphans:",d["orphans"])'
unset T
