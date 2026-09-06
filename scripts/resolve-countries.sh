#!/usr/bin/env bash
# Expands a COUNTRIES selection into country codes, or into extract filenames.
#
# Reads the same config/countries.tsv and config/groups.tsv that the Go build
# reads, so the Makefile and the ingest can never disagree about what a country
# code means or where its extract comes from.
#
#   resolve-countries.sh codes  "@nordics,pl"   -> se no fi dk is pl
#   resolve-countries.sh files  "@nordics,pl"   -> sweden-latest.osm.pbf ...
#   resolve-countries.sh url    sweden          -> https://download.geofabrik.de/...
#   resolve-countries.sh size   "@nordics"      -> total bytes
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
catalog="$here/config/countries.tsv"
groups="$here/config/groups.tsv"
mode="${1:?usage: resolve-countries.sh codes|files|url|size ARG}"
arg="${2:-}"

# url takes a bare extract basename, since that is what a Makefile pattern rule
# has to work from.
if [ "$mode" = url ]; then
  awk -F'\t' -v s="$arg" '!/^#/ && NF>=2 {n=split($2,p,"/"); if (p[n]==s) print "https://download.geofabrik.de/" $2 "-latest.osm.pbf"}' "$catalog"
  exit 0
fi

codes=$(awk -F'\t' -v sel="$arg" '
  /^#/ || NF < 2 { next }
  FILENAME == ARGV[1] { grp[$1] = $2; next }
  { known[$1] = 1 }
  END {
    n = split(sel, want, ",")
    for (i = 1; i <= n; i++) {
      k = want[i]; gsub(/^[ \t]+|[ \t]+$/, "", k)
      if (k == "") continue
      if (substr(k, 1, 1) == "@") {
        g = substr(k, 2)
        if (!(g in grp)) { print "unknown group @" g > "/dev/stderr"; exit 1 }
        m = split(grp[g], members, ",")
        for (j = 1; j <= m; j++) out[++c] = members[j]
      } else out[++c] = k
    }
    for (i = 1; i <= c; i++) {
      code = out[i]; gsub(/^[ \t]+|[ \t]+$/, "", code)
      if (!(code in known)) { print "unknown country " code > "/dev/stderr"; exit 1 }
      if (!seen[code]++) printf "%s ", code
    }
  }' "$groups" "$catalog")

case "$mode" in
  codes) echo $codes ;;
  files)
    for c in $codes; do
      awk -F'\t' -v c="$c" '$1==c {n=split($2,p,"/"); printf "%s-latest.osm.pbf ", p[n]}' "$catalog"
    done; echo ;;
  size)
    for c in $codes; do
      awk -F'\t' -v c="$c" '$1==c {print $3}' "$catalog"
    done | awk '{t+=$1} END {printf "%.1f\n", t/1073741824}' ;;
  *) echo "unknown mode $mode" >&2; exit 1 ;;
esac
