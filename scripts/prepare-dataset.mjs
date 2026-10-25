// Assemble the public dataset separately from the website build.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Resolve existing ancestors too: a new output can sit below a directory symlink.
function physicalPath(path) {
  const suffix = [];
  while (!existsSync(path)) { suffix.unshift(basename(path)); path = dirname(path); }
  return resolve(realpathSync(path), ...suffix);
}
function contains(parent, path) {
  const part = relative(parent, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export function prepareDataset(source, destination) {
  const input = resolve(source), output = resolve(destination);
  const sourcePath = realpathSync(input), outputPath = physicalPath(output);
  if (contains(sourcePath, outputPath) || contains(outputPath, sourcePath)) throw new Error('Dataset output must be separate from its input');
  const staging = `${output}.staging-${process.pid}`;
  if (existsSync(staging)) throw new Error(`Dataset staging already exists: ${staging}`);
  const report = { bytes: 0, sourceBytes: 0, files: 0, byProduct: {} };
  mkdirSync(staging, { recursive: true });
  try {
    const visit = (directory) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name), key = relative(input, path).split(sep).join('/');
        const parts = key.split('/');
        if (parts[0] === 'solar' || parts.includes('history') || name === 'EMPTY' || name.startsWith('.')) continue;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error(`Dataset contains a symbolic link: ${key}`);
        if (stat.isDirectory()) { visit(path); continue; }
        if (!stat.isFile()) throw new Error(`Dataset contains a special file: ${key}`);
        const target = join(staging, key);
        mkdirSync(dirname(target), { recursive: true });
        const immutable = parts.includes('bundles');
        if (!immutable && name.endsWith('.json')) writeFileSync(target, `${JSON.stringify(JSON.parse(readFileSync(path, 'utf8')))}\n`);
        else copyFileSync(path, target);
        const bytes = lstatSync(target).size;
        const product = parts[0] === 'soaring' ? parts.slice(0, 3).join('/') : parts[0];
        report.byProduct[product] = (report.byProduct[product] ?? 0) + bytes;
        report.bytes += bytes; report.sourceBytes += stat.size; report.files++;
      }
    };
    visit(input);
    if (!report.files) throw new Error('Dataset contains no publishable files');
    // This destination is an application build artifact. Source data stays intact.
    rmSync(output, { recursive: true, force: true });
    renameSync(staging, output);
    return report;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, destination: { type: 'string' } } });
  if (!values.source || !values.destination) throw new Error('Use --source DATA --destination OUTPUT');
  console.log(JSON.stringify(prepareDataset(values.source, values.destination), null, 2));
}
