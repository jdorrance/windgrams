import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest, validateModelDirectory } from './completeness.js';
import type { CompletenessOptions } from './completeness.js';

export interface StageOptions<T, P> extends CompletenessOptions {
  outputRoot: string; build(staging: string): Promise<T>; finish(staging: string, model: string): P | Promise<P>;
  expectedSitesAfterBuild?: (result: T) => readonly string[];
  afterPublish?: (post: P) => P | Promise<P>;
}
/**
 * Complete validation and diagnostics before replacing the current model.
 * A failed replacement rename restores the prior directory; readers may see a gap between renames.
 */
export async function stageModel<T, P>(options: StageOptions<T, P>): Promise<{ result: T; changed: boolean; post: P | null }> {
  const { outputRoot, model } = options;
  if (!/^[a-zA-Z0-9_-]+$/.test(model)) throw new Error('Invalid model path');
  mkdirSync(outputRoot, { recursive: true });
  const staging = mkdtempSync(join(outputRoot, `.build-${model}-`));
  const current = join(outputRoot, model), backup = join(staging, 'previous');
  try {
    if (existsSync(join(outputRoot, 'site-context.json'))) cpSync(join(outputRoot, 'site-context.json'), join(staging, 'site-context.json'));
    const result = await options.build(staging);
    if (!readManifest(staging, model)) {
      if (!readManifest(outputRoot, model)) throw new Error(`${model}: no complete output or last-good manifest`);
      validateModelDirectory(outputRoot, options);
      return { result, changed: false, post: null };
    }
    const validation = { ...options, expectedSites: options.expectedSitesAfterBuild?.(result) ?? options.expectedSites };
    const next = validateModelDirectory(staging, { ...validation, validateProfile: undefined });
    const previous = readManifest(outputRoot, model);
    if (previous && Date.parse(String(previous.referenceTime)) > Date.parse(next.referenceTime)) throw new Error(`${model}: refusing to replace a newer last-good run with ${next.referenceTime}`);
    let post = await options.finish(staging, model);
    validateModelDirectory(staging, validation);
    if (existsSync(current)) renameSync(current, backup);
    try { renameSync(join(staging, model), current); }
    catch (error) { if (existsSync(backup)) renameSync(backup, current); throw error; }
    if (options.afterPublish) post = await options.afterPublish(post);
    return { result, changed: true, post };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
