// The preview command rebuilds dist before running this. Link the complete
// local dataset instead of copying gigabytes or previewing only one feature.
import { access, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('../../forecasts/data/', import.meta.url);
const target = new URL('../dist/data', import.meta.url);
try {
  await access(new URL('models.json', source));
} catch {
  throw new Error('Local forecast data is missing. Build forecasts/data first; see the repository README.');
}
await symlink(fileURLToPath(source), fileURLToPath(target), 'dir');
