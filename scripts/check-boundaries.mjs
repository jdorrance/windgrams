import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { packages, filesIn, buildOrder, root } from './workspace.mjs';

const allowed = {
  contracts: [], geography: [], meteorology: ['contracts'], soaring: ['contracts', 'meteorology'],
  providers: ['contracts', 'geography'], pipeline: ['contracts', 'geography', 'meteorology', 'soaring', 'providers'],
  'data-client': ['contracts'], windgram: ['contracts', 'geography', 'meteorology'],
};
const server = new Set(['providers', 'pipeline']);
const errors = [];
function moduleImports(path) {
  const raw = readFileSync(path, 'utf8');
  const code = path.endsWith('.astro')
    ? [raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '', ...[...raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1])].join('\n')
    : raw;
  const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
  const toolkit = path.startsWith(resolve(root, 'packages') + sep);
  if (toolkit && /@ts-(?:nocheck|ignore)\b/.test(raw)) errors.push(`${relative(root, path)}: suppresses type checking`);
  const imports = [];
  const walk = node => {
    if (toolkit && node.kind === ts.SyntaxKind.AnyKeyword) errors.push(`${relative(root, path)}: use a checked type or unknown instead of any`);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) imports.push(node.arguments[0].text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) imports.push(node.argument.literal.text);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return imports;
}

function checkPublicEntry(specifier, label) {
  const dependency = specifier.split('/').slice(0, 2).join('/');
  const local = packages.find(pkg => pkg.manifest.name === dependency);
  if (!local) return;
  const subpath = specifier === dependency ? '.' : `.${specifier.slice(dependency.length)}`;
  if (!Object.hasOwn(local.manifest.exports ?? {}, subpath)) errors.push(`${label}: private package entry ${specifier}`);
}
buildOrder();
for (const { manifest, directory } of packages) {
  const name = manifest.name.replace('@windgrams/', '');
  const config = ts.readConfigFile(resolve(directory, 'tsconfig.json'), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
  if (!options.strict || options.noImplicitAny === false || options.allowJs) errors.push(`${manifest.name}: packages require strict TypeScript`);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith('@windgrams/') && !allowed[name]?.includes(dependency.replace('@windgrams/', ''))) {
      errors.push(`${manifest.name}: forbidden dependency ${dependency}`);
    }
  }
  for (const path of filesIn(resolve(directory, 'src')).filter(path => /\.[cm]?[jt]sx?$/.test(path))) {
    if (/\.[cm]?jsx?$/.test(path)) errors.push(`${relative(root, path)}: toolkit implementation must be TypeScript`);
    for (const specifier of moduleImports(path)) {
      const label = `${relative(directory, path)}: ${specifier}`;
      if (specifier.startsWith('.')) {
        const target = resolve(path, '..', specifier);
        if (!target.startsWith(resolve(directory, 'src') + sep)) errors.push(`${manifest.name} imports outside its source tree (${label})`);
        continue;
      }
      if (specifier.startsWith('node:')) {
        if (!server.has(name)) errors.push(`${manifest.name} has a server dependency (${label})`);
        continue;
      }
      const dependency = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (!(dependency in (manifest.dependencies ?? {}))) errors.push(`${manifest.name} has an undeclared dependency (${label})`);
      checkPublicEntry(specifier, `${manifest.name} (${label})`);
    }
  }
}
// Applications consume the same public interfaces as an installed toolkit user.
// Package tests may inspect kernels directly; production code may not.
for (const [application, folders] of [['web', ['src', 'worker', 'scripts']], ['forecasts', ['scripts', 'soaring', 'verification']]]) {
  const manifest = JSON.parse(readFileSync(resolve(root, application, 'package.json'), 'utf8'));
  for (const folder of folders) for (const path of filesIn(resolve(root, application, folder)).filter(path => /\.(?:[cm]?[jt]sx?|astro)$/.test(path) && !/\.test\.[cm]?[jt]sx?$/.test(path))) {
    for (const specifier of moduleImports(path)) {
      const label = relative(root, path);
      if (specifier.startsWith('@windgrams/')) {
        const dependency = specifier.split('/').slice(0, 2).join('/');
        if (!(dependency in (manifest.dependencies ?? {}))) errors.push(`${label}: undeclared dependency ${dependency}`);
        checkPublicEntry(specifier, label);
      } else if (specifier.startsWith('.') && resolve(path, '..', specifier).startsWith(resolve(root, 'packages') + sep)) {
        errors.push(`${label}: import package through its public name (${specifier})`);
      }
    }
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`Package boundaries passed (${packages.length} packages).`);
