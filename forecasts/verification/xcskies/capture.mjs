// Response-only capture: authenticated browser transport supplies JSON, never credentials.
import { readFile, writeFile, mkdir, appendFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bytesOf, sha256 } from '../evidence-store.mjs';

export const MODEL_PAIRS = [
  ['gfs', 'gfs'],
  ['hrrr', 'hrrr-conus'],
  ['rrfs', 'rrfs'],
  ['iconeu', 'icon-eu'],
];
const currentHour = () => new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
const epochIso = (epoch) =>
  Number.isSafeInteger(epoch) && epoch >= 0 && Number.isFinite(new Date(epoch * 1000).getTime())
    ? new Date(epoch * 1000).toISOString()
    : null;

export function profileUrl({ model, latitude, longitude, selectedAt, backdays = 1 }) {
  if (!MODEL_PAIRS.some(([id]) => id === model)) throw new Error('Unsupported observed model');
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180)
    throw new Error('Invalid coordinates');
  const time = new Date(selectedAt);
  if (
    typeof selectedAt !== 'string' ||
    !/(?:Z|[+-]\d\d:\d\d)$/.test(selectedAt) ||
    !Number.isFinite(+time) ||
    time.getUTCMinutes() ||
    time.getUTCSeconds() ||
    time.getUTCMilliseconds()
  )
    throw new Error('selectedAt must be an exact UTC hour');
  if (backdays !== 1) throw new Error('Only observed backdays=1 is supported');
  const iso = time.toISOString(),
    date = iso.slice(0, 10).replaceAll('-', ''),
    hour = iso.slice(11, 13);
  const url = new URL(`https://n1.xcskies.com/profile/${model}/${date}/${hour}/00`);
  url.search = new URLSearchParams({ lat: latitude, lon: longitude, backdays });
  return url.href;
}

export function makeRequests(baseline, { selectedAt = currentHour() } = {}) {
  if (
    !Array.isArray(baseline?.sites) ||
    !Array.isArray(baseline.matches) ||
    baseline.sites.some((site) => typeof site?.slug !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(site.slug)) ||
    new Set(baseline.sites.map((site) => site.slug)).size !== baseline.sites.length
  )
    throw new Error('Invalid baseline site inventory');
  const shared = new Set(
    baseline.matches.filter((match) => match.status === 'matched').map((match) => match.site.slug),
  );
  const focus = new Set(['wa-blanchard', 'wa-tiger-mountain', 'wa-rampart-ridge']);
  const priority = (site) => (focus.has(site.slug) ? 0 : shared.has(site.slug) ? 1 : 2);
  return baseline.sites
    .toSorted((a, b) => priority(a) - priority(b) || a.slug.localeCompare(b.slug))
    .flatMap((site) =>
      MODEL_PAIRS.filter(([model]) => model === 'gfs' || (model === 'iconeu') === site.slug.startsWith('am-')).map(
        ([model, ourModel]) => {
          const request = { site, model, ourModel, selectedAt, backdays: 1, sharedWithWxToFly: shared.has(site.slug) };
          return {
            ...request,
            id: `${site.slug}:${model}`,
            url: profileUrl({ ...request, latitude: site.latitude, longitude: site.longitude }),
          };
        },
      ),
    );
}

export async function beginCapture({ baseline, output, selectedAt = currentHour() }) {
  const root = resolve(output),
    source = await readFile(join(baseline, 'snapshot.json'));
  const requests = makeRequests(JSON.parse(source), { selectedAt });
  await mkdir(join(root, 'objects'), { recursive: true });
  const plan = {
    schemaVersion: 1,
    provider: 'XC Skies',
    startedAt: new Date().toISOString(),
    baseline: { path: resolve(baseline), sha256: sha256(source) },
    transport:
      'Authenticated browser navigation; JSON response text only. No request headers, cookies, credentials or account details are retained.',
    selectedAt,
    requests,
  };
  await writeFile(join(root, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  return plan;
}

async function openPlan(root, request) {
  try {
    await access(join(root, 'snapshot.json'));
    throw Object.assign(new Error('Capture is complete; use a new output directory'), { code: 'EEXIST' });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const plan = JSON.parse(await readFile(join(root, 'plan.json'), 'utf8'));
  if (request && !plan.requests.some((item) => item.id === request.id && item.url === request.url))
    throw new Error('Request is outside the frozen capture plan');
  return plan;
}

const appendResponse = async (root, entry) => {
  await appendFile(join(root, 'responses.ndjson'), JSON.stringify(entry) + '\n');
  return entry;
};

export async function recordResponse(
  root,
  request,
  { text, finalUrl, retrievedAt = new Date().toISOString(), role = 'primary' },
) {
  await openPlan(root, request);
  if (finalUrl !== request.url) throw new Error('Response URL differs from requested forecast');
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024 * 1024)
    throw new Error('Invalid response text size');
  if (typeof role !== 'string' || !role.trim()) throw new Error('Response role is required');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Browser response is not JSON; authentication or delivery may have changed');
  }
  const hash = sha256(text),
    file = `objects/${hash}`;
  try {
    await writeFile(join(root, file), text, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await bytesOf(root, { file, sha256: hash });
  }
  const epochs = Array.isArray(data?.epochs) ? data.epochs : [],
    count = epochs.length;
  return appendResponse(root, {
    id: request.id,
    role,
    url: request.url,
    finalUrl,
    retrievedAt,
    sha256: hash,
    file,
    bytes: Buffer.byteLength(text),
    responseStatus: data?.status ?? null,
    hourCount: count,
    firstValidAt: epochIso(epochs[0]),
    lastValidAt: epochIso(epochs.at(-1)),
    completeSurfaceColumns:
      count > 0 && ['tmp2m', 'u10m', 'v10m'].every((key) => Array.isArray(data[key]) && data[key].length === count),
    referenceTime: null,
    httpStatus: null,
    representation: 'Browser JSON document text; HTTP headers not exported',
  });
}

export async function recordFailure(root, request, error) {
  await openPlan(root, request);
  return appendResponse(root, {
    id: request.id,
    role: 'primary',
    url: request.url,
    retrievedAt: new Date().toISOString(),
    error: String(error).slice(0, 300),
  });
}

export async function finishCapture(root) {
  const plan = await openPlan(root);
  let journal = '';
  try {
    journal = await readFile(join(root, 'responses.ndjson'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const responses = journal.split('\n').filter(Boolean).map(JSON.parse);
  const requests = new Map(plan.requests.map((request) => [request.id, request]));
  for (const response of responses) {
    if (requests.get(response.id)?.url !== response.url || (response.file && response.finalUrl !== response.url))
      throw new Error('Response is outside the frozen capture plan');
    if (response.file) await bytesOf(root, response);
  }
  const primary = Map.groupBy(
    responses.filter((response) => response.role === 'primary'),
    (response) => response.id,
  );
  if ([...primary.values()].some((entries) => entries.length !== 1))
    throw new Error('Capture has ambiguous primary responses');
  if (plan.requests.some((request) => !primary.has(request.id))) throw new Error('Capture has pending requests');
  let discovery = [];
  try {
    discovery = JSON.parse(await readFile(join(root, 'discovery/evidence.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const entry of discovery) if (entry.file) await bytesOf(root, entry);
  const snapshot = {
    ...plan,
    completedAt: new Date().toISOString(),
    responses,
    discovery,
    limitations: [
      'The URL date/hour is a request anchor derived from the browser clock by the official client, not verified model initialization. Per-hour initialization and native source cells are absent from profile responses.',
      'Historical hours are retrospectively retrieved provider data; they are not independently proven first-issued forecasts.',
      'Only original baseline locations with frozen Windgrams point profiles can be compared; other locations provide an XC inventory.',
    ],
  };
  await writeFile(join(root, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
  return snapshot;
}
