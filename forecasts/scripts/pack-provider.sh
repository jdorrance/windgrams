#!/bin/sh
# Each provider owns only its profiles/history and regional model pointers.
# Shared cached data must never enter another provider's refreshed artifact.
set -eu
provider="${1:?provider}"
slice="${2:-slice}"
pack() { sh scripts/pack-slice.sh "$slice" "$@"; }
case "$provider" in
  noaa-cloud)
    pack hrrr-conus gfs history/hrrr-conus history/gfs soaring/v1/regions.json
    for case_dir in data/soaring/v1/*; do
      [ -d "$case_dir" ] || continue
      case "$case_dir" in *-rrfs-live) continue ;; esac
      pack "${case_dir#data/}"
    done
    ;;
  rrfs)
    pack rrfs history/rrfs soaring/v1/regions-rrfs.json
    for case_dir in data/soaring/v1/*-rrfs-live; do
      [ -d "$case_dir" ] || continue
      pack "${case_dir#data/}"
    done
    ;;
  eccc) pack hrdps-continental rdps gdps geps history/hrdps-continental history/rdps history/gdps history/geps ;;
  *) echo "Unknown provider: $provider" >&2; exit 1 ;;
esac
