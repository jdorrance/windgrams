#!/usr/bin/env python3
"""Compatibility entry point; the provider package owns the native decoder."""
from pathlib import Path
import runpy
import subprocess
from urllib.parse import urlparse, unquote

url = subprocess.check_output([
    'node', '--input-type=module', '-e',
    "process.stdout.write(import.meta.resolve('@windgrams/providers/icon-decoder'))"
], cwd=Path(__file__).parent, text=True)
globals().update(runpy.run_path(unquote(urlparse(url).path), run_name=__name__))
