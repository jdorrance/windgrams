#!/usr/bin/env bash
# Builds one model into ./data for local use.
#
# meteo reads the published manifest from METEO_DATA_BASE before it builds.
# A 404 means that model is not in the tree yet and the build goes ahead.
# A connection failure aborts the build, so this checks the server first.
#
# Usage, from forecasts/, while `pnpm dev` is running in web/:
#   scripts/build-local.sh hrrr-conus
#   METEO_DATA_BASE=https://data.example/data scripts/build-local.sh gfs
set -euo pipefail
cd "$(dirname "$0")/.."
model="${1:?usage: scripts/build-local.sh <model-slug>}"
if [[ -z "${METEO_DATA_BASE:-}" ]]; then
  export METEO_DATA_BASE="http://127.0.0.1:4321/data"
fi
code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${METEO_DATA_BASE}/models.json" || true)"
if [[ "$code" == "000" || -z "$code" ]]; then
  echo "cannot reach ${METEO_DATA_BASE} (start web/: pnpm dev, or set METEO_DATA_BASE to the published dataset URL)" >&2
  exit 1
fi
exec pnpm exec meteo forecast build --model "$model" --sites sites.json --output data --no-history
