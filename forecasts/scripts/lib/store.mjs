// Dataset store used when a script publishes with --publish or --sync.
//
// The only built-in provider writes a directory on disk. Another provider
// (object storage, a bucket, anything with get/put) registers itself:
//
//   import { registerStoreProvider } from "./lib/store.mjs";
//   registerStoreProvider("example", (env) => ({ name: "example", get, put }));
//
// Select it with WINDGRAMS_STORE. The file provider is the default and reads
// WINDGRAMS_DATA_DIR.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const providers = new Map();

export function registerStoreProvider(name, create) {
  providers.set(name, create);
}

function fileStore(root) {
  const base = resolve(root);
  const pathFor = (key) => {
    if (typeof key !== "string" || key === "" || key.startsWith("/") || key.includes("..")) {
      throw new Error(`invalid dataset key: ${key}`);
    }
    const path = resolve(base, key);
    if (path !== base && !path.startsWith(base + sep)) throw new Error(`invalid dataset key: ${key}`);
    return path;
  };
  return {
    name: `file:${base}`,
    async put(key, body) {
      const path = pathFor(key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    },
    async get(key) {
      try {
        return readFileSync(pathFor(key));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

registerStoreProvider("file", (env) => {
  if (!env.WINDGRAMS_DATA_DIR) throw new Error("WINDGRAMS_DATA_DIR is required for the file dataset store");
  return fileStore(env.WINDGRAMS_DATA_DIR);
});

export function storeFromEnv(env = process.env) {
  const name = env.WINDGRAMS_STORE || "file";
  const create = providers.get(name);
  if (!create) {
    throw new Error(`unknown dataset store "${name}". Registered: ${[...providers.keys()].join(", ")}. Add one with registerStoreProvider.`);
  }
  return create(env);
}
