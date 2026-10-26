// Frozen provider routing and repeated-response audits; never inferred forecast initialization.
import { isDeepStrictEqual } from 'node:util';

const finite = Number.isFinite;
const iso = (value) => new Date(value).toISOString();
const unique = (values) => [...new Set(values)];

/** Runtime JSONP is data, never evaluated. It describes server routing, not proven PointCast provenance. */
export function parseRuntimeMetadata(text) {
  const match = /^\s*d3\.jsonp\.capture\((\{[\s\S]*\})\);?\s*$/.exec(text);
  if (!match) throw new Error('Invalid frozen runtime JSONP wrapper');
  const data = JSON.parse(match[1]);
  if (
    !data.runtimes ||
    typeof data.runtimes !== 'object' ||
    Array.isArray(data.runtimes) ||
    Object.values(data.runtimes).some(
      (entries) => !Array.isArray(entries) || entries.some((entry) => !entry || typeof entry !== 'object'),
    )
  )
    throw new Error('Invalid runtime metadata');
  return data.runtimes;
}

export function runtimeIndex(runtime) {
  const index = new Map();
  for (const [model, entries] of Object.entries(runtime))
    for (const entry of entries) {
      if (!finite(entry.epoch)) continue;
      const date = String(entry.zday),
        hour = String(entry.zrun).padStart(2, '0');
      const reference =
        /^\d{8}$/.test(date) && /^\d{2}$/.test(hour)
          ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${hour}:00:00.000Z`
          : null;
      index.set(`${model}:${entry.epoch}`, {
        referenceTime: reference && Number.isFinite(Date.parse(reference)) ? reference : null,
        state: entry.state ?? null,
        updated: entry.updated ?? null,
      });
    }
  return index;
}

export function auditRuntimeChanges(metadata, requestedModels) {
  const ordered = [...metadata].sort((a, b) => Date.parse(a.entry.retrievedAt) - Date.parse(b.entry.retrievedAt));
  if (ordered.length < 2)
    return { status: 'not-repeated', models: [], evidence: ordered.map((item) => item.entry.sha256) };
  const before = ordered[0],
    after = ordered.at(-1),
    models = [];
  for (const model of unique(requestedModels).sort()) {
    const prefix = `${model}:`,
      old = [...before.index].filter(([key]) => key.startsWith(prefix)),
      current = [...after.index].filter(([key]) => key.startsWith(prefix));
    const changes = [];
    let ageTextOnlyCount = 0;
    for (const [key, value] of old) {
      const newer = after.index.get(key);
      if (!newer) continue;
      const referenceChanged = value.referenceTime !== newer.referenceTime,
        stateChanged = value.state !== newer.state;
      if (referenceChanged || stateChanged)
        changes.push({
          validAt: iso(Number(key.slice(prefix.length)) * 1000),
          referenceChanged,
          stateChanged,
          before: value,
          after: newer,
        });
      else if (value.updated !== newer.updated) ageTextOnlyCount++;
    }
    models.push({
      model,
      beforeHours: old.length,
      afterHours: current.length,
      addedHours: current.filter(([key]) => !before.index.has(key)).length,
      removedHours: old.filter(([key]) => !after.index.has(key)).length,
      changedRunHours: changes.filter((change) => change.referenceChanged).length,
      changedStateHours: changes.filter((change) => change.stateChanged).length,
      ageTextOnlyCount,
      changes,
    });
  }
  return {
    status: 'repeated-routing-context',
    beforeRetrievedAt: before.entry.retrievedAt,
    afterRetrievedAt: after.entry.retrievedAt,
    evidence: [before.entry.sha256, after.entry.sha256],
    models,
    limitation:
      'Runtime routing is not proof of the run used in any profile column; capture bracketing is evaluated separately for each response.',
  };
}

export function describeResponseChanges(before, after) {
  const keys = unique([...Object.keys(before), ...Object.keys(after)]).filter(
    (key) => !isDeepStrictEqual(before[key], after[key]),
  );
  if (!isDeepStrictEqual(before.epochs, after.epochs))
    return { topLevelKeysChanged: keys, timelineChanged: true, changedHourCount: null, byField: {} };
  const epochs = before.epochs ?? [],
    changed = new Set(),
    byField = {};
  for (const key of keys)
    if (
      Array.isArray(before[key]) &&
      Array.isArray(after[key]) &&
      before[key].length === epochs.length &&
      after[key].length === epochs.length
    ) {
      const indices = epochs
        .map((_, index) => index)
        .filter((index) => !isDeepStrictEqual(before[key][index], after[key][index]));
      for (const index of indices) changed.add(index);
      byField[key] = indices.length;
    }
  const changedValidTimes = [...changed].sort((a, b) => a - b).map((index) => iso(epochs[index] * 1000));
  return {
    topLevelKeysChanged: keys,
    timelineChanged: false,
    changedHourCount: changed.size,
    changedValidTimes,
    byField,
  };
}

export function routingFor(model, validAt, metadata, retrievedAt) {
  const key = `${model}:${Date.parse(validAt) / 1000}`;
  const matches = metadata
    .map((item) => ({ ...item.index.get(key), evidence: item.entry.sha256, capturedAt: item.entry.retrievedAt }))
    .filter((item) => item.referenceTime);
  const references = unique(matches.map((item) => item.referenceTime));
  const retrievalTime = Date.parse(retrievedAt),
    captureTimes = matches.map((item) => Date.parse(item.capturedAt));
  const bracketed =
    matches.length >= 2 &&
    finite(retrievalTime) &&
    captureTimes.every(finite) &&
    Math.min(...captureTimes) <= retrievalTime &&
    Math.max(...captureTimes) >= retrievalTime;
  return {
    referenceTime: references.length === 1 ? references[0] : null,
    status: !bracketed
      ? 'not-bracketed'
      : references.length > 1
        ? 'changed-during-capture'
        : 'unchanged-routing-metadata',
    bracketed,
    routingTimesAgree: references.length === 1 && matches.length >= 2,
    interpretation: 'Per-valid-time provider routing; not verified as the initialization of this PointCast column.',
    records: matches,
  };
}
