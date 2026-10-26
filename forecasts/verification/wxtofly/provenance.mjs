// Identify the evaluator and renderer actually used, separately from the served publication.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../evidence-store.mjs';
export async function implementationIdentity() {
  const sources = [
      ['review', fileURLToPath(new URL('..', import.meta.url))],
      ['renderer', fileURLToPath(new URL('.', import.meta.resolve('@windgrams/windgram/scene')))],
    ],
    files = [];
  for (const [owner, root] of sources)
    for (const path of (await readdir(root, { recursive: true })).sort()) {
      if (!(owner === 'review' ? /\.mjs$/ : /\.(?:js|json)$/).test(path) || path.includes('.test.')) continue;
      files.push({ path: `${owner}/${path}`, sha256: sha256(await readFile(join(root, path))) });
    }
  return {
    sha256: sha256(JSON.stringify(files)),
    node: process.version,
    files,
    scope: 'Review code and built checkout renderer; not the deployed JavaScript identity.',
  };
}
