import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from 'node:crypto';
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyGroup, collectGroup, groupHasLocal } from "./seed-published.mjs";
import { isPublishedCase } from './merge-soaring-regions.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), "seed-published.mjs");

test("collectGroup follows a model manifest and skips a 404", async () => {
  const docs = {
    "hrrr-conus/manifest.json": { model: "hrrr-conus", sites: [{ slug: "va-daniels" }, { slug: "va-eagle-rock" }] },
    "hrrr-conus/sites/va-daniels.json": { slug: "va-daniels" },
    "gfs/manifest.json": null,
  };
  const files = await collectGroup("noaa-cloud", {
    get: async (key) => (Object.hasOwn(docs, key) ? docs[key] : null),
  });
  assert.deepEqual([...files.keys()], ["hrrr-conus/manifest.json", "hrrr-conus/sites/va-daniels.json"]);
});

test("collectGroup reads NWS offices, ECMWF sites, and one balloon file per launch", async () => {
  const asked = [];
  await collectGroup("observations", {
    sites: [{ slug: "va-daniels" }],
    get: async (key) => {
      asked.push(key);
      if (key === "nws/manifest.json") return { sites: [{ slug: "va-daniels" }], offices: [{ office: "LWX" }] };
      if (key === "ecmwf/manifest.json") return { sites: [{ slug: "va-daniels" }] };
      return { key };
    },
  });
  assert.deepEqual(asked, [
    "nws/manifest.json",
    "nws/sites/va-daniels.json",
    "nws/offices/LWX.json",
    "ecmwf/manifest.json",
    "ecmwf/sites/va-daniels.json",
    "raob/sites/va-daniels.json",
  ]);
});

test("--list prints that group's model slugs", () => {
  const listed = spawnSync(process.execPath, [script, "--list", "noaa-cloud"], { encoding: "utf8" });
  assert.equal(listed.status, 0);
  assert.equal(listed.stdout, "hrrr-conus gfs\n");
  const missing = spawnSync(process.execPath, [script, "--list", "nope"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
});

test("applyGroup replaces a model directory and leaves an unfetched model", () => {
  const output = mkdtempSync(join(tmpdir(), "seed-"));
  mkdirSync(join(output, "hrrr-conus", "sites"), { recursive: true });
  mkdirSync(join(output, "gfs"), { recursive: true });
  writeFileSync(join(output, "hrrr-conus", "sites", "old.json"), "{}\n");
  writeFileSync(join(output, "gfs", "manifest.json"), "{}\n");
  applyGroup(output, "noaa-cloud", new Map([
    ["hrrr-conus/manifest.json", { model: "hrrr-conus" }],
    ["hrrr-conus/sites/va-daniels.json", { slug: "va-daniels" }],
  ]));
  assert.equal(readFileSync(join(output, "hrrr-conus", "sites", "va-daniels.json"), "utf8").includes("va-daniels"), true);
  assert.equal(readFileSync(join(output, "gfs", "manifest.json"), "utf8"), "{}\n");
  assert.throws(() => readFileSync(join(output, "hrrr-conus", "sites", "old.json")));
  assert.equal(groupHasLocal(output, "noaa-cloud"), true);
});

function soaringDocuments(version) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const caseId = 'north-rrfs-live';
  const bundle = `bundles/${hash(version)}`;
  const root = `soaring/v1/${caseId}/${bundle}`;
  // Whitespace is intentionally significant: reserializing invalidates hashes.
  const profile = Buffer.from(`{ "version": "${version}" }\n`);
  const manifest = Buffer.from(JSON.stringify({ case: { id: caseId }, files: { 'profile.json': hash(profile) } }, null, 2));
  const index = Buffer.from(JSON.stringify({ bundle, manifestSha256: hash(manifest) }, null, 2));
  const regions = Buffer.from(JSON.stringify({ regions: [{ id: 'north', nativeModels: [{ model: 'rrfs', caseId }] }] }, null, 2));
  return new Map([
    ['soaring/v1/regions.json', regions],
    ['soaring/v1/regions-rrfs.json', regions],
    [`soaring/v1/${caseId}/index.json`, index],
    [`${root}/manifest.json`, manifest],
    [`${root}/profile.json`, profile],
  ]);
}

test('soaring seed preserves hashed bytes and follows native RRFS pointers', async t => {
  const output = mkdtempSync(join(tmpdir(), 'seed-soaring-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const docs = soaringDocuments('new');
  const files = await collectGroup('soaring', { getBytes: async key => docs.get(key) ?? null });
  applyGroup(output, 'soaring', files);
  for (const [key, bytes] of docs) assert.deepEqual(readFileSync(join(output, key)), bytes);
  assert.equal(isPublishedCase(join(output, 'soaring', 'v1'), 'north-rrfs-live'), true);
  assert.equal(groupHasLocal(output, 'soaring'), true);
});

test('incomplete or corrupted soaring seeds leave last-good pointers and catalogues intact', async t => {
  const output = mkdtempSync(join(tmpdir(), 'seed-soaring-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const old = soaringDocuments('old');
  applyGroup(output, 'soaring', old);
  for (const mode of ['missing-file', 'corrupt-file', 'corrupt-manifest', 'missing-pointer']) {
    const docs = soaringDocuments('new');
    const profileKey = [...docs.keys()].find(key => key.endsWith('/profile.json'));
    const manifestKey = [...docs.keys()].find(key => key.endsWith('/manifest.json'));
    if (mode === 'missing-file') docs.delete(profileKey);
    if (mode === 'corrupt-file') docs.set(profileKey, Buffer.from('{}'));
    if (mode === 'corrupt-manifest') docs.set(manifestKey, Buffer.from('{}'));
    if (mode === 'missing-pointer') docs.delete('soaring/v1/north-rrfs-live/index.json');
    await assert.rejects(async () => {
      const files = await collectGroup('soaring', { getBytes: async key => docs.get(key) ?? null });
      applyGroup(output, 'soaring', files);
    }, /Incomplete|corrupt|Missing/);
    for (const [key, bytes] of old) assert.deepEqual(readFileSync(join(output, key)), bytes);
    assert.equal(isPublishedCase(join(output, 'soaring', 'v1'), 'north-rrfs-live'), true);
  }
});
