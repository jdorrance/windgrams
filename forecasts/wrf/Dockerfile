# Pinned WRF-ARW / WPS 4.6.0 pilot image for North Sound 3 km / 1 km nested domain
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    WRF_VERSION=4.6.0 \
    WPS_VERSION=4.6.0 \
    WRF_DIR=/wrf

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential gfortran m4 curl ca-certificates git file \
    libnetcdf-dev libnetcdff-dev netcdf-bin \
    libhdf5-openmpi-dev openmpi-bin libopenmpi-dev \
    libpng-dev zlib1g-dev libjasper-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /wrf
COPY domain.json namelist.wps namelist.input run-pilot.sh /wrf/
RUN chmod +x /wrf/run-pilot.sh

ENTRYPOINT ["/wrf/run-pilot.sh"]
