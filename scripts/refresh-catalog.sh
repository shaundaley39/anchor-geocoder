#!/usr/bin/env bash
# Refreshes config/countries.tsv from Geofabrik's published index.
#
# Adding a country used to mean finding its download path by hand and pasting a
# byte count, which is both tedious and a thing to get wrong. Geofabrik
# publishes index-v1.json listing every extract with its path, so the catalogue
# can be generated from it:
#
#   scripts/refresh-catalog.sh              # refresh sizes for what is listed
#   scripts/refresh-catalog.sh add gr cy     # add countries by ISO code
#   scripts/refresh-catalog.sh list          # every extract available
#   scripts/refresh-catalog.sh list asia     # ...in one continent
#   scripts/refresh-catalog.sh add-all       # every country on earth
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

# Country-level extracts, optionally within one continent. A country, not a
# continent and not a sub-region: the first is too coarse to give the API a
# country code, the second too fine to be one.
all_extracts() {
  python3 - "$cache" "${1:-}" <<'INNER'
import json, sys

# Geofabrik's index mis-tags a handful of small Pacific extracts: six claim
# Vanuatu's code and two the Marshall Islands'. Taken at face value the
# catalogue would have six entries fighting over "vu". The path says what each
# one actually is.
OVERRIDE = {
    'australia-oceania/american-oceania': 'as',
    'australia-oceania/ile-de-clipperton': 'cp',
    'australia-oceania/polynesie-francaise': 'pf',
    'australia-oceania/tokelau': 'tk',
    'australia-oceania/wallis-et-futuna': 'wf',
    'australia-oceania/pitcairn-islands': 'pn',
}

d = json.load(open(sys.argv[1]))
want = sys.argv[2] if len(sys.argv) > 2 else ''
for f in d['features']:
    p = f['properties']
    pbf = p.get('urls', {}).get('pbf', '')
    if not pbf:
        continue
    path = (pbf.replace('https://download.geofabrik.de/', '')
               .replace('-latest.osm.pbf', ''))
    depth = path.count('/')
    # Depth 1 is a country within a continent; russia and antarctica are
    # continent-level files that happen to be one country each.
    if depth != 1 and path not in ('russia', 'antarctica'):
        continue
    iso = p.get('iso3166-1:alpha2') or []
    code = OVERRIDE.get(path) or (iso[0].lower() if iso else '')
    if not code:
        continue
    if want and not (path == want or path.startswith(want + '/')):
        continue
    print(f"{code}\t{path}\t{p['name']}")
INNER
}

size_of() {
  curl -sIL "$base/$1-latest.osm.pbf" 2>/dev/null \
    | awk 'tolower($1)=="content-length:"{n=$2} END{gsub(/\r/,"",n); print n}'
}

case "${1:-refresh}" in
list)
  fetch_index
  all_extracts "${2:-}" | sort | awk -F'\t' '{printf "  %-4s %-34s %s\n", $1, $3, $2}'
  ;;
add)
  fetch_index
  shift
  for code in "$@"; do
    line=$(all_extracts | awk -F'\t' -v c="$code" '$1==c' | head -1)
    [ -n "$line" ] || { echo "no extract for '$code'" >&2; exit 1; }
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
add-all)
  # Every country Geofabrik publishes, skipping what the catalogue already has,
  # so hand-tuned entries survive. A HEAD each for the size, which takes a few
  # minutes and is polite about it.
  fetch_index
  added=0
  while IFS=$'\t' read -r code path name; do
    grep -q "^$code	" "$catalog" && continue
    sz=$(size_of "$path")
    [ -n "$sz" ] || { echo "  could not size $path, skipping" >&2; continue; }
    printf '%s\t%s\t%s\t%s\n' "$code" "$path" "$sz" "$name" >> "$catalog"
    printf '  added %-4s %-34s %6.2f GB\n' "$code" "$name" "$(echo "$sz/1073741824" | bc -l)"
    added=$((added + 1))
    sleep 0.3
  done < <(all_extracts | sort)
  echo "  $added added"
  { grep '^#' "$catalog"; grep -v '^#' "$catalog" | grep -v '^$' | sort; } > "$catalog.tmp"
  mv "$catalog.tmp" "$catalog"
  ;;
*) echo "usage: refresh-catalog.sh [list [continent]|add CODE...|add-all|refresh]" >&2; exit 2;;
esac
