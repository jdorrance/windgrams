import { modelDescriptor } from './registry.ts';
import { acquireIcon } from './internal/icon-native.ts';
import { parseIconAcquisition } from './internal/icon-json.ts';
import { iconAreaFields, prepareIconArea, selectIconArea } from './internal/icon-area.ts';
import type { AreaAcquisitionAdapter, IconAreaOptions, IconAreaResult } from './area-types.ts';

export type {
  AreaAcquisitionAdapter, AreaAcquisitionRequest, AreaAcquisitionResult, AreaCell,
  IconAreaOptions, IconAreaResult,
} from './area-types.ts';

/** Acquire native ICON-EU cells inside explicit bounds for one run and forecast horizon. */
export function createIconAreaAdapter(options: IconAreaOptions = {}): AreaAcquisitionAdapter<IconAreaResult> {
  const model = modelDescriptor('icon-eu');
  const { acquire = acquireIcon, ...acquisitionOptions } = options;
  return {
    model,
    fields: iconAreaFields,
    async acquire(request) {
      const selection = prepareIconArea(request, model);
      const raw = await acquire({
        ...acquisitionOptions,
        referenceTime: selection.run.referenceTime,
        forecastHours: selection.forecastHours,
        bbox: selection.bounds,
        cacheDir: selection.cacheDir,
        signal: selection.signal,
      });
      selection.signal?.throwIfAborted();
      return selectIconArea(parseIconAcquisition(raw), selection, model);
    },
  };
}
