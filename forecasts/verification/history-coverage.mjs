// Calendar coverage of retained run directories versus validated first-issued selections.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const day = (time) => new Date(time).toISOString().slice(0, 10);
const dateOfKey = (key) =>
  `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T${key.slice(9, 11)}:${key.slice(11, 13)}:${key.slice(13, 15)}Z`;

/** Presence is inventory, not successful validation or an implied complete forecast cadence. */
export function calendarHistoryCoverage({ dataRoot, models, from, to, selectedRuns = [] }) {
  const start = Date.parse(from),
    end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end - start > 120 * 86400000)
    throw new Error('Calendar coverage requires an ordered window of at most 120 days');
  if (!Array.isArray(models) || models.some((model) => !/^[a-zA-Z0-9_-]+$/.test(model)))
    throw new Error('Invalid coverage model inventory');
  const dates = [];
  for (let time = Date.parse(`${day(start)}T00:00:00Z`); time <= end; time += 86400000) dates.push(day(time));
  const byModel = models.map((model) => {
    const root = join(dataRoot, 'history', model);
    const all = existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}Z$/.test(entry.name))
          .map((entry) => entry.name)
          .sort()
      : [];
    const retained = all.filter((key) => Date.parse(dateOfKey(key)) >= start && Date.parse(dateOfKey(key)) <= end);
    const selected = selectedRuns.filter((run) => run.model === model && retained.includes(run.runKey));
    const days = dates.map((date) => ({
      date,
      retainedRuns: retained.filter((key) => dateOfKey(key).startsWith(date)).length,
      selectedFirstIssuedRuns: selected.filter((run) => dateOfKey(run.runKey).startsWith(date)).length,
    }));
    return {
      model,
      retainedRunCount: retained.length,
      selectedFirstIssuedRunCount: selected.length,
      unselectedRunCount: retained.filter((key) => !selected.some((run) => run.runKey === key)).length,
      retainedInitializationDates: days.filter((item) => item.retainedRuns).length,
      missingInitializationDates: days.filter((item) => !item.retainedRuns).map((item) => item.date),
      earliestRetainedReferenceTime: all.length ? dateOfKey(all[0]) : null,
      latestRetainedReferenceTime: all.length ? dateOfKey(all.at(-1)) : null,
      days,
    };
  });
  return {
    window: { from, to, endpoints: 'inclusive' },
    requestedUtcDates: dates.length,
    byModel,
    note: 'A day with a run is not complete daily coverage. Retained directory counts do not validate their contents. Selected first-issued runs are hash-checked by the history reader; the scorer run limit may omit retained days. Valid-time coverage and independent station-days are separate.',
  };
}
