// The preview command rebuilds dist before running this. Link the complete
// local dataset instead of copying gigabytes or previewing only one feature.
import { access, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { localDataConfiguration } from '../config/data-mode.mjs';

const dataset = localDataConfiguration();
const target = new URL('../dist/data', import.meta.url);
try {
  await access(join(dataset.root, 'models.json'));
} catch {
  throw new Error(dataset.sample
    ? 'Synthetic fixtures are missing. Run pnpm dev-data first; see web/README.md.'
    : 'Local forecast data is missing. Build forecasts/data first; see the repository README.');
}
await rm(target, { recursive: true, force: true });
await symlink(dataset.root, fileURLToPath(target), 'dir');
