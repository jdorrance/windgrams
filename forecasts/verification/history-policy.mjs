// Operator retention policy. Storage and scientific comparison definitions stay separate.
import { DEFAULT_MAX_ROLLING_RUNS, DEFAULT_PINNED_RUN_KEYS } from './issued-history.mjs';
import { REGRESSION_SITES } from './definitions.mjs';

export const OPERATOR_HISTORY_POLICY = Object.freeze({
  maxRollingRuns: DEFAULT_MAX_ROLLING_RUNS,
  minimumCalendarDays: 30,
  pinnedRunKeys: DEFAULT_PINNED_RUN_KEYS,
  retainFullColumnSites: REGRESSION_SITES,
});
