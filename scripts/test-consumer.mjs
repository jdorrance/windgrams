import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { root, packages } from './workspace.mjs';

const pnpm = process.env.WINDGRAMS_PNPM_CLI ?? process.env.npm_execpath;
if (!pnpm || !/pnpm/.test(pnpm)) throw new Error('Run with pnpm test:consumer (or set WINDGRAMS_PNPM_CLI).');
const temporary = mkdtempSync(join(tmpdir(), 'windgrams-consumer-'));
const run = (args, cwd) => {
  const result = spawnSync(process.execPath, args, { cwd, env: process.env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Consumer command failed (${result.status}): ${args.join(' ')}`);
};
try {
  const tarballs = join(temporary, 'tarballs'); mkdirSync(tarballs);
  for (const pkg of packages) run([pnpm, 'pack', '--pack-destination', tarballs], pkg.directory);
  const dependencies = Object.fromEntries(packages.map(pkg => {
    const archive = `${pkg.manifest.name.replace('@', '').replace('/', '-')}-${pkg.manifest.version}.tgz`;
    if (!readdirSync(tarballs).includes(archive)) throw new Error(`Missing package archive ${archive}`);
    return [pkg.manifest.name, `file:${join(tarballs, archive)}`];
  }));
  const consumer = join(temporary, 'app'); mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'independent-weather-consumer', private: true, type: 'module', dependencies, pnpm: { overrides: dependencies } }, null, 2));
  // This is a separate install, with registry dependencies cached after workspace setup.
  run([pnpm, 'install', '--prefer-offline', '--ignore-scripts', '--config.manage-package-manager-versions=false'], consumer);
  for (const file of ['run.mts', 'contracts.mts']) {
    cpSync(join(root, 'scripts/fixtures/consumer', file), join(consumer, file));
  }
  const typeImports = packages.flatMap(pkg => Object.entries(pkg.manifest.exports)
    .filter(([, target]) => typeof target === 'object' && target.types)
    .map(([entry]) => pkg.manifest.name + (entry === '.' ? '' : entry.slice(1))));
  writeFileSync(join(consumer, 'entries.mts'), typeImports.map((entry, i) => `import type * as Entry${i} from '${entry}';`).join('\n'));
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    skipLibCheck: false, outDir: 'compiled', types: ['node'], typeRoots: [join(root, 'node_modules/@types')],
  }, files: ['entries.mts', 'contracts.mts', 'run.mts'] }, null, 2));
  run([join(root, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], consumer);
  console.log(`Public API checks passed (${typeImports.length} entry points).`);
  cpSync(join(root, 'forecasts/soaring/fixtures/blanchard-published.json'), join(consumer, 'compiled/profile.json'));
  run([join(consumer, 'compiled/run.mjs')], consumer);

  // A separate browser entry cannot pull server acquisition or filesystem modules.
  const require = createRequire(join(root, 'web/package.json'));
  const vite = require.resolve('vite', { paths: [dirname(require.resolve('astro'))] });
  const esbuildPath = require.resolve('esbuild', { paths: [dirname(vite)] });
  const { build } = await import(esbuildPath);
  const browserEntry = join(consumer, 'browser.mjs');
  const browserEntries = {
    contracts: '@windgrams/contracts',
    fields: '@windgrams/contracts/fields',
    regional: '@windgrams/contracts/regional',
    client: '@windgrams/data-client',
    dataset: '@windgrams/data-client/dataset',
    offline: '@windgrams/data-client/offline',
    browserStore: '@windgrams/data-client/offline-browser',
    scene: '@windgrams/windgram/scene',
    svg: '@windgrams/windgram/svg/external',
    dom: '@windgrams/windgram/dom',
    registry: '@windgrams/providers/registry',
    terrainPolicy: '@windgrams/providers/terrain-policy',
  };
  writeFileSync(browserEntry, [
    ...Object.entries(browserEntries).map(([name, entry]) => `export * as ${name} from '${entry}';`),
    "import '@windgrams/windgram/styles.css';",
  ].join('\n'));
  const bundle = await build({ entryPoints: [browserEntry], bundle: true, platform: 'browser', format: 'esm', outdir: join(consumer, 'bundle'), write: false, metafile: true });
  const forbidden = Object.keys(bundle.metafile.inputs).filter(path =>
    /(?:@windgrams\/pipeline|meteo\.forecast|meteo\.grib|icon-decode)/.test(path)
    || /windgram\/dist\/generated\/styles\.js$/.test(path)
    || (path.includes('/@windgrams/providers/') && !/\/dist\/(?:registry\.js|terrain-policy\.js|catalogue-0\.6\.0\.json|forecast-hours-0\.6\.0\.json)$/.test(path)));
  if (forbidden.length) throw new Error(`Server modules in browser bundle: ${forbidden.join(', ')}`);
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css'));
  if (!css?.text.includes('.windgram .wg-inspector-agl')) throw new Error('Browser stylesheet missing from the package');
  console.log(`Browser bundle and stylesheet checked (${bundle.outputFiles.reduce((total, file) => total + file.contents.length, 0)} bytes before minification).`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
