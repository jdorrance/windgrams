#!/usr/bin/env python3
"""Offline decoder checks; run with the pinned icon-requirements environment."""
import importlib.util
import json
from pathlib import Path
import unittest
import sys
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('icon_decode', Path(__file__).with_name('icon-decode.py'))
icon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icon)
FIXTURE = json.loads(Path(__file__).with_name('icon-native-fixture.json').read_text())


class NativeDecoder(unittest.TestCase):
    def test_native_run_and_grid_identity(self):
        meta = FIXTURE['records']['T:7:45']['metadata']
        icon.verify_meta(meta, meta, '2026-10-24T06:00:00Z', 7)
        for changed in [dict(meta, uuidOfHGrid='wrong'), dict(meta, validityTime=1400), dict(meta, dataTime=0), dict(meta, endHour=8)]:
            with self.assertRaises(ValueError):
                icon.verify_meta(changed, meta, '2026-10-24T06:00:00Z', 7)

    def test_rejects_partial_or_multiple_grib_messages(self):
        for body in [b'', b'GRIB', b'GRIB' + bytes(100) + b'7777']:
            with self.assertRaises(ValueError):
                icon.grib_decode(body)

    def test_native_paths_and_contiguous_range_batching(self):
        self.assertEqual(icon.field_url('HHL', '2026-10-24T06:00:00Z', 0, 75),
                         icon.BASE + 'HHL/lvt1/150/lv1/75/r/2026-10-24T06%3A00/s/PT000H00M.grib2')
        self.assertEqual(icon.range_groups([130, 1, 2, 130, 500], gap=128), [[1, 130], [500, 500]])

    def test_rejects_wrong_netcdf_format_and_stopped_budget_before_network(self):
        with self.assertRaises(ValueError):
            icon.NetCDFHeader(b'CDF\x01' + bytes(128))
        fetch = icon.Fetcher('/tmp/windgrams-icon-offline-test', 1)
        fetch.stopped.set()
        with self.assertRaisesRegex(ValueError, 'budget'):
            fetch.get(icon.BASE)


if __name__ == '__main__':
    unittest.main()
