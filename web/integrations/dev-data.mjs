// Serves forecast documents at /data during `astro dev`.
// A deployed host serves the same paths from its own dataset store.
// `sample` marks the responses so the launch page can say they are not a forecast.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export default function devData({ root = "../forecasts/data", sample = false } = {}) {
  return {
    name: "dev-data",
    hooks: {
      "astro:config:setup": ({ config, command, updateConfig }) => {
        // Checks/builds must not replace a running dev server's optimized imports.
        // Different base paths also produce different browser dependency URLs.
        updateConfig({ vite: { cacheDir: resolve(
          fileURLToPath(config.root), 'node_modules/.vite', command, encodeURIComponent(config.base),
        ) } });
      },
      "astro:server:setup": ({ server, logger }) => {
        const base = resolve(root);
        if (!existsSync(base)) {
          logger.warn(`${root}/ not found; build forecasts into forecasts/data (see the README)`);
        }
        // The Worker's station endpoint. A file under the forecast root is served
        // as-is. With no file, answer 503 the way the Worker does when WU_API_KEY
        // is unset, so the page says the station is not connected.
        server.middlewares.use("/api/stations", (req, res) => {
          const id = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\//, "");
          const path = join(base, "api", "stations", `${id}.json`);
          if (!/^[A-Z0-9]{3,20}$/.test(id)) {
            res.statusCode = 404;
            res.setHeader("content-type", "application/json");
            res.end('{"error":"not found"}');
            return;
          }
          if (!existsSync(path)) {
            res.statusCode = 503;
            res.setHeader("content-type", "application/json");
            res.setHeader("cache-control", "no-store");
            res.end('{"error":"not connected"}');
            return;
          }
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          if (sample) res.setHeader("x-sample-data", "true");
          res.end(readFileSync(path));
        });
        server.middlewares.use("/data", (req, res) => {
          const path = normalize(join(base, decodeURIComponent((req.url ?? "/").split("?")[0])));
          if (!path.startsWith(base + sep) || !existsSync(path) || !statSync(path).isFile()) {
            res.statusCode = 404;
            res.setHeader("content-type", "application/json");
            res.end('{"error":"not found"}');
            return;
          }
          res.setHeader("content-type", path.endsWith(".gz") ? "application/gzip" : "application/json");
          res.setHeader("cache-control", "no-store");
          if (sample) res.setHeader("x-sample-data", "true");
          res.end(readFileSync(path));
        });
      },
    },
  };
}
