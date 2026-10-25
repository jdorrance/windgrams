# @windgrams/data-client

Fetch published point forecasts and regional map data in a browser or Node app.
The client handles retries and checks that a point profile belongs to the run
advertised by its manifest.

```ts
import { createForecastClient } from '@windgrams/data-client';

const requests = new AbortController();
const client = createForecastClient({
  baseUrl: '/data',
  signal: requests.signal,
});

const result = await client.loadProfile('hrrr-conus', 'wa-blanchard');
if ('document' in result && !result.stale) {
  console.log(result.document.hours);
}

// When the page or component is removed:
requests.abort();
```

`loadProfile` returns either a manifest/profile pair or a miss. A pair marked
`stale` still has mismatched run identities after a retry; check that flag before
presenting the profile as the advertised run. Forecast age is a separate question:
[`assessForecastFreshness`](src/freshness.ts) compares the initialization and last
valid time with an explicit clock and the model catalogue's update cadence.
Its `nextCheckAt` tells you when to reassess. Schedule that check in your app and
clear the timer when the view is removed.

For other documents, `readJson(path, validate)` returns your validated value,
returns `null` for a 404, and throws for invalid data or other HTTP failures.
Supply a custom `fetch` to add credentials or use a different transport.

## Regional maps

`readRegional` handles JSON and gzip files and returns `unknown`. Validate the
result with [`@windgrams/contracts/regional`](../contracts/README.md).
[`createReplayProfileCache`](src/regional.ts) then loads cell profiles for one
manifest, checking their model, run, grid cell and hours. It shares in-flight
requests and keeps eight profiles by default. Create a new cache when the
manifest changes; pass a reader with your cancellation signal.

The [`/http` helpers](src/http.ts) are also available separately. Requests get up
to three attempts with a 15-second timeout per attempt by default. Cancellation
stops both requests and retry waits. See the [client types](src/products.ts) for
configuration and result types.
