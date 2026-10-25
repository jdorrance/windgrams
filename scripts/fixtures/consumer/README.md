# Packed-package checks

`pnpm test:consumer` installs the package tarballs outside the workspace, then
compiles these fixtures and runs the acquisition-to-chart smoke test.
[`contracts.mts`](contracts.mts) checks accepted calls and expected type errors;
[`run.mts`](run.mts) uses a retained forecast through the public APIs.

The [runner](../../test-consumer.mjs) also bundles browser entry points and the
chart stylesheet. Temporary files are removed after the checks.
