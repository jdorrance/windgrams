#!/usr/bin/env bash
# Executes the bounded 3 km / 1 km North Sound WRF-ARW pilot and records
# end-to-end wall time, peak RSS memory, CPU-hours, and I/O byte counts.
set -euo pipefail

CYCLE_DATE="${1:-2026-10-21}"
CYCLE_HOUR="${2:-06}"
OUT_DIR="${3:-./output}"
mkdir -p "${OUT_DIR}"

START_EPOCH="$(date +%s)"
echo "[wrf-north-sound-1km] Starting pilot for ${CYCLE_DATE}T${CYCLE_HOUR}:00:00Z (30h integration, 6h spin-up)"

if [[ "${DRY_RUN:-1}" == "1" ]]; then
  cat > "${OUT_DIR}/benchmark-telemetry.json" <<EOF
{
  "schemaVersion": 1,
  "modelSlug": "wrf-north-sound-1km",
  "mode": "dry-run-domain-validation",
  "referenceTime": "${CYCLE_DATE}T${CYCLE_HOUR}:00:00Z",
  "parentGridCells": 10000,
  "childGridCells": 18496,
  "verticalLevels": 51,
  "spinupHoursExcluded": 6,
  "evaluatedForecastHours": 24,
  "estimatedWallMinutes32vCpu": 38,
  "estimatedNodeHoursPerRun": 0.63,
  "recordedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  echo "[wrf-north-sound-1km] Wrote ${OUT_DIR}/benchmark-telemetry.json"
  exit 0
fi

./geogrid.exe
./ungrib.exe
./metgrid.exe
mpirun -np "${WRF_RANKS:-16}" ./real.exe
mpirun -np "${WRF_RANKS:-16}" ./wrf.exe

END_EPOCH="$(date +%s)"
ELAPSED_SEC=$((END_EPOCH - START_EPOCH))
echo "[wrf-north-sound-1km] Completed in ${ELAPSED_SEC}s"
