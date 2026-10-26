// Phase 2: Publishes regional soaring replay/grid bundles through the
// repository's store abstraction (forecasts/scripts/lib/store.mjs).
// Writes immutable content-addressed bundle objects first, verifies every
// SHA-256 digest, and only then atomically advances the case index pointer.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { storeFromEnv } from "./lib/store.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function publishSoaringCase(sourceRoot, caseId, store) {
  const caseDir = join(resolve(sourceRoot), "soaring", "v1", caseId);
  const indexPath = join(caseDir, "index.json");
  if (!existsSync(indexPath)) {
    throw new Error(`Missing soaring case index: ${indexPath}`);
  }
  const pointer = JSON.parse(readFileSync(indexPath, "utf8"));
  if (typeof pointer.bundle !== "string" || !/^bundles\/[a-f0-9]{64}$/.test(pointer.bundle)) {
    throw new Error(`Invalid bundle pointer in ${indexPath}`);
  }
  const bundleDir = join(caseDir, pointer.bundle);
  const manifestPath = join(bundleDir, "manifest.json");
  const manifestBytes = readFileSync(manifestPath);
  if (sha256(manifestBytes) !== pointer.manifestSha256) {
    throw new Error(`Manifest SHA-256 mismatch for ${caseId}`);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const uploaded = [];

  for (const [fileName, expectedHash] of Object.entries(manifest.files ?? {})) {
    const filePath = join(bundleDir, fileName);
    const bytes = readFileSync(filePath);
    if (sha256(bytes) !== expectedHash) {
      throw new Error(`Checksum mismatch before publish: ${fileName}`);
    }
    const key = `soaring/v1/${caseId}/${pointer.bundle}/${fileName}`;
    await store.put(key, bytes);
    uploaded.push(key);
  }

  const manifestKey = `soaring/v1/${caseId}/${pointer.bundle}/manifest.json`;
  await store.put(manifestKey, manifestBytes);
  uploaded.push(manifestKey);

  // Advance pointer last so a partial upload never exposes an incomplete bundle.
  const indexKey = `soaring/v1/${caseId}/index.json`;
  await store.put(indexKey, readFileSync(indexPath));
  uploaded.push(indexKey);

  return { caseId, bundle: pointer.bundle, uploadedCount: uploaded.length, storeName: store.name };
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string", default: "data" },
      case: { type: "string" },
    },
  });
  if (!values.case) throw new Error('Specify the regional case to publish with --case CASE_ID');
  const store = storeFromEnv();
  const result = await publishSoaringCase(values.source, values.case, store);
  console.log(`Published ${result.uploadedCount} soaring object(s) for ${result.caseId} (${result.bundle}) to ${result.storeName}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
