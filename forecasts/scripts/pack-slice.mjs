import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// A new output may sit below an existing directory symlink.
function physicalPath(path) {
  const suffix = [];
  while (!existsSync(path)) { suffix.unshift(basename(path)); path = dirname(path); }
  return resolve(realpathSync(path), ...suffix);
}

/** Replace one artifact slice; absent source paths never leave stale output behind. */
export function packSlice(destination, names, source = 'data') {
  const root = resolve(source), output = resolve(destination);
  const within = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };
  const sourcePath = physicalPath(root), outputPath = physicalPath(output);
  if (within(root, output) || within(output, root) || within(sourcePath, outputPath) || within(outputPath, sourcePath)) throw new Error('Artifact source and destination must be separate directories.');
  for (const name of names) {
    if (!name || isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid artifact path: ${name}`);
    const selected = physicalPath(join(root, name));
    if (within(selected, outputPath) || within(outputPath, selected)) throw new Error('Artifact source and destination must be separate directories.');
  }
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  let copied = 0;
  for (const name of names) {
    if (!existsSync(join(root, name))) continue;
    const target = join(output, name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, name), target, { recursive: true, preserveTimestamps: true });
    copied++;
  }
  if (!copied) writeFileSync(join(output, 'EMPTY'), 'empty\n');
  return copied;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, ...names] = process.argv.slice(2);
  if (!destination || !names.length) throw new Error('Usage: node scripts/pack-slice.mjs DESTINATION PATH...');
  packSlice(destination, names);
}
