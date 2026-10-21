#!/bin/sh
# Copy named paths from forecasts/data into a directory that becomes one artifact.
# A missing path is skipped. An empty slice still gets a marker so the artifact exists.
set -eu
slice="${1:?slice directory}"
shift
mkdir -p "$slice"
found=0
for name in "$@"; do
  if [ -e "data/$name" ]; then
    parent=$(dirname "$name")
    mkdir -p "$slice/$parent"
    cp -a "data/$name" "$slice/$name"
    found=1
  fi
done
if [ "$found" = 0 ]; then
  # A visible file, so the artifact upload does not drop a hidden marker and
  # then fail the job that simply had nothing new to publish.
  printf 'empty\n' > "$slice/EMPTY"
fi
