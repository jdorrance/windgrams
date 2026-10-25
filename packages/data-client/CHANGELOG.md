# Changelog

## 0.1.0 (unreleased)

Initial version with manifest/profile reads, cancellable HTTP retries, regional profile caching and forecast freshness assessment.

The `/dataset` entry discovers regional products, opens a fixed bundle and samples
native cells and forecast times. It loads profiles from either published shards
or older hourly arrays, and supports saved subsets through an injected reader.

The `/offline` entry saves selected forecast files with checksum verification,
resumable downloads and atomic replacement. `/offline-browser` supplies persistent
IndexedDB storage coordinated across tabs.
