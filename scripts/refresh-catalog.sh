#!/usr/bin/env bash
# Refreshes config/countries.tsv from Geofabrik's published index.
#
# Adding a country used to mean finding its download path by hand and pasting a
# byte count, which is both tedious and a thing to get wrong. Geofabrik
# publishes index-v1.json listing every extract with its path, so the catalogue
# can be generated from it:
#
#   scripts/refresh-catalog.sh            # refresh sizes for what is listed
#   scripts/refresh-catalog.sh add gr cy   # add countries by ISO code
#   scripts/refresh-catalog.sh list        # every European extract available
#
# The index carries paths and names but not sizes, so those come from a HEAD.
# Note the redirect: the request lands on a dated filename, and only the final
# response has the real Content-Length — the 302 reports the length of its own
# HTML body. Geofabrik rate-limits, so this sleeps between requests and is meant
# to be run rarely, never in CI.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
catalog="$here/config/countries.tsv"
index_url="https://download.geofabrik.de/index-v1.json"
base="https://download.geofabrik.de"
cache="${TMPDIR:-/tmp}/geofabrik-index.json"

fetch_index() {
  if [ ! -s "$cache" ] || [ -n "${REFRESH:-}" ]; then
    echo "fetching $index_url" >&2
    curl -fsSL -o "$cache" "$index_url"
  fi
}

# Europe-only, and only leaf extracts: a country, not a continent or a region.
europe_extracts() {
  python3 - "$cache" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for f in d['features']:
    p = f['properties']
    urls = p.get('urls', {})
    pbf = urls.get('pbf', '')
    if '/europe/' not in pbf:
        continue
    # Skip sub-regions: they have a parent that is itself a European country.
    if pbf.count('/') > 5:
        continue
    iso = (p.get('iso3166-1:alpha2') or [None])[0]
    if not iso:
        continue
    path = (pbf.replace('https://download.geofabrik.de/', '')
               .replace('-latest.osm.pbf', ''))
    print(f"{iso.lower()}\t{path}\t{p['name']}")
PY
}

size_of() {
  curl -sIL "$base/$1-latest.osm.pbf" 2>/dev/null \
    | awk 'tolower($1)=="content-length:"{n=$2} END{gsub(/\r/,"",n); print n}'
}

case "${1:-refresh}" in
list)
  fetch_index
  europe_extracts | sort | awk -F'\t' '{printf "  %-4s %-34s %s\n", $1, $3, $2}'
  ;;
add)
  fetch_index
  shift
  for code in "$@"; do
    line=$(europe_extracts | awk -F'\t' -v c="$code" '$1==c')
    [ -n "$line" ] || { echo "no European extract for '$code'" >&2; exit 1; }
    if grep -q "^$code	" "$catalog"; then
      echo "  $code already present"; continue
    fi
    path=$(echo "$line" | cut -f2); name=$(echo "$line" | cut -f3)
    sz=$(size_of "$path")
    [ -n "$sz" ] || { echo "could not size $path" >&2; exit 1; }
    printf '%s\t%s\t%s\t%s\n' "$code" "$path" "$sz" "$name" >> "$catalog"
    echo "  added $code $name ($((sz / 1000000)) MB)"
    sleep 1
  done
  # Keep the file sorted by code, comments first.
  { grep '^#' "$catalog"; grep -v '^#' "$catalog" | grep -v '^$' | sort; } > "$catalog.tmp"
  mv "$catalog.tmp" "$catalog"
  ;;
refresh)
  fetch_index
  while IFS=$'\t' read -r code path sz name; do
    case "$code" in ''|'#'*) continue;; esac
    new=$(size_of "$path")
    if [ -n "$new" ] && [ "$new" != "$sz" ]; then
      echo "  $code $sz -> $new"
      sed -i.bak "s|^$code	$path	$sz	|$code	$path	$new	|" "$catalog"
      rm -f "$catalog.bak"
    fi
    sleep 1
  done < "$catalog"
  ;;
*) echo "usage: refresh-catalog.sh [list|add CODE...|refresh]" >&2; exit 2;;
esac
