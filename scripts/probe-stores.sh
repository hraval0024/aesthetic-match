#!/bin/bash
# Phase 0 spike: validate data/candidate_stores.json against each store's public
# /products.json endpoint. Read-only, polite (sequential + 1s delay), no auth.
# This same file is the input to the real ingestion pipeline (Phase 2), which
# performs its own per-run health check -- this script is just the upfront sanity
# check so we don't design ingestion against a seed list that doesn't work.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANDIDATES_FILE="${REPO_ROOT}/data/candidate_stores.json"

if [ ! -f "$CANDIDATES_FILE" ]; then
  echo "Missing $CANDIDATES_FILE" >&2
  exit 1
fi

printf "%-24s %-22s %-6s %-6s %-10s %s\n" "DOMAIN" "ARCHETYPE" "HTTP" "COUNT" "VERDICT" "NOTE"
printf '%.0s-' {1..100}; echo

python3 -c "
import json
with open('$CANDIDATES_FILE') as f:
    for entry in json.load(f):
        print(f\"{entry['domain']}\t{entry['archetype']}\")
" | while IFS=$'\t' read -r domain archetype; do
  url="https://${domain}/products.json?limit=5"
  resp=$(curl -sL -m 10 -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" -w '\n%{http_code}' "$url" 2>/dev/null || true)
  http_code=$(echo "$resp" | tail -1)
  body=$(echo "$resp" | sed '$d')

  result=$(echo "$body" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    prods = d.get('products', None)
    if prods is None:
        print('NOJSON|-')
    else:
        print(f'OK|{len(prods)}')
except Exception:
    print('NOJSON|-')
" 2>/dev/null)

  status_part="${result%%|*}"
  count_part="${result##*|}"

  if [ "$http_code" = "200" ] && [ "$status_part" = "OK" ]; then
    verdict="OK"; note=""
  elif [ "$http_code" = "200" ] && [ "$status_part" = "NOJSON" ]; then
    verdict="BLOCKED"; note="200 but not product JSON (likely bot-challenge/HTML)"
  elif [ "$http_code" = "403" ] || [ "$http_code" = "401" ]; then
    verdict="BLOCKED"; note="access denied"
  elif [ "$http_code" = "404" ]; then
    verdict="DISABLED"; note="endpoint not found"
  else
    verdict="ERROR"; note="http $http_code"
  fi

  printf "%-24s %-22s %-6s %-6s %-10s %s\n" "$domain" "$archetype" "$http_code" "$count_part" "$verdict" "$note"
  sleep 1
done
