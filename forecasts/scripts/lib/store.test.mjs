import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerStoreProvider, storeFromEnv } from "./store.mjs";

test("the file store round-trips an object and misses a missing key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "windgrams-store-"));
  try {
    const store = storeFromEnv({ WINDGRAMS_DATA_DIR: dir });
    assert.equal(await store.get("nws/sites/va-daniels.json"), null);
    await store.put("nws/sites/va-daniels.json", Buffer.from('{"ok":true}'));
    assert.equal((await store.get("nws/sites/va-daniels.json")).toString("utf-8"), '{"ok":true}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the file store refuses a key that leaves its directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "windgrams-store-"));
  try {
    const store = storeFromEnv({ WINDGRAMS_STORE: "file", WINDGRAMS_DATA_DIR: dir });
    await assert.rejects(() => store.get("../secret.json"), /invalid dataset key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unregistered store name says how to add one", () => {
  registerStoreProvider("example", () => ({ name: "example", get: async () => null, put: async () => {} }));
  assert.equal(storeFromEnv({ WINDGRAMS_STORE: "example" }).name, "example");
  assert.throws(() => storeFromEnv({ WINDGRAMS_STORE: "missing" }), /registerStoreProvider/);
});
