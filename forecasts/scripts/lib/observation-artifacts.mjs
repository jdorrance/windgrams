// Observation refreshes are partial: the manifest records attempts; payloads keep their own observation times.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJson, replaceTree, timestamp, writeJson } from './artifact-products.mjs';
import { parseObservationManifest } from './observation-manifest.mjs';

const identity = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
const optional = read => { try { return read(); } catch { return null; } };
const copy = (source, destination) => {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { preserveTimestamps: true });
};

function document(path, key, expected, product) {
  const value = readJson(path);
  if (value.schemaVersion !== 1 || (key === 'site' ? value.site?.slug : value.office) !== expected) throw new Error('Invalid observation document identity');
  timestamp(value.generatedAt);
  if (product === 'raob' && !Array.isArray(value.soundings)) throw new Error('Invalid sounding document');
  return { path, value };
}

/** Merge a newer attempt atomically, retaining last-good failed sites and their office products. */
export function mergeObservationProduct(source, destination, product) {
  const next = parseObservationManifest(readJson(join(source, 'manifest.json')), product);
  const previous = optional(() => readJson(join(destination, 'manifest.json')));
  if (!next) throw new Error('Invalid observation manifest');
  const generatedAt = timestamp(next.generatedAt);
  if (previous && timestamp(previous.generatedAt) >= generatedAt) return false;

  const scratch = mkdtempSync(join(tmpdir(), 'windgrams-observations-')), candidate = join(scratch, product);
  try {
    if (existsSync(destination)) cpSync(destination, candidate, { recursive: true, preserveTimestamps: true });
    else mkdirSync(candidate, { recursive: true });
    const retainedOffices = new Set();
    const sites = next.sites.map(site => {
      const key = `sites/${site.slug}.json`, incomingPath = join(source, key), previousPath = join(destination, key);
      if (site.absent === true) {
        rmSync(join(candidate, key), { force: true });
        const { retained: _retained, ...status } = site;
        return status;
      }
      const prior = optional(() => document(previousPath, 'site', site.slug, product));
      const incoming = site.ok ? document(incomingPath, 'site', site.slug, product) : optional(() => document(incomingPath, 'site', site.slug, product));
      // A seeded failed payload may be older than the publisher's cache. Keep the newest actual payload.
      const selected = !site.ok && prior && (!incoming || timestamp(prior.value.generatedAt) > timestamp(incoming.value.generatedAt)) ? prior : incoming;
      const { retained: _retained, ...status } = site;
      if (!selected) {
        rmSync(join(candidate, key), { force: true });
        return status;
      }
      copy(selected.path, join(candidate, key));
      const retained = !site.ok || selected === prior;
      if (product === 'nws' && retained && identity(selected.value.grid?.office)) retainedOffices.add(selected.value.grid.office);
      return retained ? { ...status, retained: true } : status;
    });
    const manifest = { ...next, sites };
    if (product === 'nws') {
      const offices = new Map();
      for (const entry of next.offices) {
        const key = `offices/${entry.office}.json`, incoming = document(join(source, key), 'office', entry.office);
        const prior = optional(() => document(join(destination, key), 'office', entry.office));
        const selected = prior && timestamp(prior.value.generatedAt) > timestamp(incoming.value.generatedAt) ? prior : incoming;
        copy(selected.path, join(candidate, key));
        offices.set(entry.office, selected);
      }
      for (const office of retainedOffices) if (!offices.has(office)) {
        const key = `offices/${office}.json`;
        const selected = optional(() => document(join(destination, key), 'office', office)) ?? optional(() => document(join(source, key), 'office', office));
        if (selected) { copy(selected.path, join(candidate, key)); offices.set(office, selected); }
      }
      manifest.offices = [...offices].map(([office, selected]) => ({ office,
        afdIssuanceTime: selected.value.products?.afd?.issuanceTime ?? null,
        srgIssuanceTime: selected.value.products?.srg?.issuanceTime ?? null,
      }));
    }
    writeJson(join(candidate, 'manifest.json'), manifest);
    replaceTree(candidate, destination);
    return true;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
