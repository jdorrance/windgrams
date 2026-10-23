import { readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseIdx, parseFields, parseGrid, parseProduct, byteRange } from '@azohra/meteo.grib';
import { assertRuntime, atomicWrite, concurrent, fileUrl, json, modelFor, readJson, sha256, validAt, versionsFor } from './common.mjs';
import { fields, selectRecords, parameters, fixedSurface } from './fields.mjs';

export async function verifiedBytes(root, entry) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(entry.file)) throw new Error('Unsafe cache filename');
  const bytes = await readFile(join(root, entry.file));
  if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw new Error(`Corrupt cache: ${entry.file}`);
  return bytes;
}

// An asset becomes reusable only after its complete bytes pass validation.
// A failed response leaves neither a digest receipt nor a reusable partial file.
export async function captureAsset(root, file, url, record, validate, fetchImpl = fetch) {
  const receiptPath = join(root, `${file}.json`);
  let saved;
  try { saved = await readJson(receiptPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (saved) {
    if (saved.url !== url || saved.range !== (record ? byteRange(record) : null)) throw new Error(`Cache request mismatch: ${file}`);
    const bytes = await verifiedBytes(root, saved);
    validate(bytes);
    return saved;
  }
  let bytes;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(url, { headers: record ? { Range: byteRange(record) } : {}, signal: AbortSignal.timeout(90000) });
      if (response.status !== (record ? 206 : 200)) throw new Error(`HTTP ${response.status}: ${url}; expected ${record ? '206 Range response' : '200'}`);
      if (record) {
        const range = response.headers.get('content-range');
        if (!range?.startsWith(`bytes ${record.offset}-${record.offset + record.length - 1}/`)) throw new Error(`Wrong Content-Range: ${range}`);
      }
      bytes = Buffer.from(await response.arrayBuffer());
      if (record && bytes.length !== record.length) throw new Error(`Partial download: ${file}`);
      validate(bytes);
      break;
    } catch (e) { if (attempt === 2) throw e; }
  }
  const entry = { file, url, range: record ? byteRange(record) : null, size: bytes.length, sha256: sha256(bytes) };
  await atomicWrite(join(root, file), bytes);
  await atomicWrite(receiptPath, json(entry));
  return entry;
}

export function inspectField(bytes, c, hour, expectedGrid, selection) {
  const parsed = parseFields(bytes);
  if (parsed.length !== 1) throw new Error('Expected a single field per selected record');
  const field = parsed[0], id = field.identification;
  const referenceTime = new Date(Date.UTC(id.year, id.month - 1, id.day, id.hour, id.minute, id.second)).toISOString().replace('.000Z', 'Z');
  if (referenceTime !== c.referenceTime) throw new Error(`Wrong run: ${referenceTime}`);
  const product = parseProduct(field.section4);
  const accumulation = modelFor(c) === 'rrfs' && product.parameterCategory === 1 && product.parameterNumber === 8;
  // RRFS precipitation is the one-hour accumulation ending at validAt. Validate
  // the raw PDT 4.8 range because parseProduct deliberately exposes only its
  // shared PDT 4.0 fields. Never accept run-total accumulation as hourly rain.
  if (field.discipline !== 0 || product.productDefinitionTemplateNumber !== (accumulation ? 8 : 0)) throw new Error('Unsupported discipline/product template');
  if (accumulation) {
    const s = new DataView(field.section4.buffer, field.section4.byteOffset, field.section4.byteLength);
    if (s.byteLength < 58) throw new Error('Truncated precipitation interval');
    const end = new Date(Date.UTC(s.getUint16(34), s.getUint8(36) - 1, s.getUint8(37), s.getUint8(38), s.getUint8(39), s.getUint8(40))).toISOString().replace('.000Z', 'Z');
    if (end !== validAt(c, hour) || s.getUint8(41) !== 1 || s.getUint8(46) !== 1 || s.getUint8(48) !== 1 || s.getUint32(49) !== 1) throw new Error('Wrong precipitation interval: expected one-hour accumulation ending at validAt');
    Object.assign(product, { intervalEnd: end, statisticalProcess: 'accumulation', intervalHours: 1 });
  }
  const unit = product.indicatorOfUnitOfTimeRange, step = product.forecastTime;
  if (selection) {
    const [category, number] = parameters[selection.variable];
    const [surface, value] = fixedSurface(selection.level);
    const scaled = product.scaledValueOfFirstFixedSurface * 10 ** -product.scaleFactorOfFirstFixedSurface;
    if (product.parameterCategory !== category || product.parameterNumber !== number || product.typeOfFirstFixedSurface !== surface || scaled !== value) {
      throw new Error(`Wrong GRIB variable/level for ${selection.key}`);
    }
  }
  const expectedStep = accumulation ? hour - 1 : hour;
  if (unit !== 1 || step !== expectedStep) throw new Error(`Wrong/unsupported forecast time: PDT ${product.productDefinitionTemplateNumber}, unit ${unit}, step ${step}, expected ${expectedStep}`);
  const grid = parseGrid(field.section3);
  if (grid.kind !== 'lambert' || (expectedGrid && grid.gridKey !== expectedGrid)) throw new Error(`Inconsistent grid: ${grid.gridKey}`);
  return { field, grid, product, referenceTime, validAt: validAt(c, hour) };
}

export async function capture(c, root, { fetchImpl = fetch, log = console.error } = {}) {
  await assertRuntime(c);
  await mkdir(root, { recursive: true });
  // Exclude simultaneous writers; an interrupted process's lock may be removed
  // after confirming that it is no longer running.
  const lock = join(root, 'capture.lock');
  await mkdir(lock);
  try {
    const caseHash = sha256(json(c));
    let state;
    try { state = await readJson(join(root, 'identity.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (state && state.caseHash !== caseHash) throw new Error('Cached case definition changed');
    state ??= { caseHash, capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
    await atomicWrite(join(root, 'identity.json'), json(state));
    const hours = [c.terrainForecastHour, ...c.forecastHours];
    const sources = [];
    let gridKey;
    for (const hour of hours) {
      const products = modelFor(c) === 'rrfs' ? [...new Set(fields(c, hour).map(f => f.product))] : [null];
      const indices = {}, selections = [];
      for (const product of products) {
        const url = fileUrl(c, hour, product ?? undefined);
        const index = await captureAsset(root, `f${hour}${product ? `-${product}` : ''}.idx`, `${url}.idx`, null, bytes => {
          const text = bytes.toString();
          const stamp = c.referenceTime.slice(0, 13).replace(/[-T:]/g, '');
          if (!text.trim().split('\n').every(line => line.split(':')[2] === `d=${stamp}`)) throw new Error('Wrong index run');
          selectRecords(parseIdx(text), c, hour, product);
        }, fetchImpl);
        indices[product ?? 'default'] = index;
        selections.push(...selectRecords(parseIdx((await verifiedBytes(root, index)).toString()), c, hour, product));
      }
      const byKey = new Map(selections.map(s => [s.key, s]));
      const selected = fields(c, hour).map(f => byKey.get(f.key));
      const captureConcurrency = Number(process.env.SOARING_CAPTURE_CONCURRENCY) || 4;
      const records = await concurrent(selected, captureConcurrency, async selection => {
        if (!selection.record) return { key: selection.key, absent: true };
        let metadata;
        const asset = await captureAsset(root, `f${hour}-${selection.key}.grib2`, fileUrl(c, hour, selection.product), selection.record, bytes => {
          metadata = inspectField(bytes, c, hour, gridKey, selection);
          gridKey ??= metadata.grid.gridKey;
        }, fetchImpl);
        return { ...asset, key: selection.key, gridKey: metadata.grid.gridKey, referenceTime: metadata.referenceTime, validAt: metadata.validAt, product: metadata.product };
      });
      sources.push({ hour, ...(modelFor(c) === 'rrfs' ? { indices } : { index: indices.default }), records });
      log(`Captured f${hour}: ${records.filter(r => !r.absent).length} fields verified`);
    }
    const manifest = { schemaVersion: 1, ...state, case: c, versions: versionsFor(c), gridKey, sources };
    await atomicWrite(join(root, 'capture.json'), json(manifest));
    return manifest;
  } finally { await rm(lock, { recursive: true, force: true }); }
}
