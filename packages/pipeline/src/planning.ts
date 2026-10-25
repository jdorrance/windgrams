import type { AcquisitionResult, SelectedRun } from '@windgrams/providers';
export interface BuildPlan { model: string; run: SelectedRun; reason: 'new-run' | 'backfill' | 'repair' }
export function planModelBuild(input: { run: SelectedRun | null; publishedRun?: string; complete: boolean; inventoryMatches: boolean }): BuildPlan | null {
  if (!input.run) return null;
  const next = Date.parse(input.run.referenceTime), current = Date.parse(input.publishedRun ?? '');
  if (!Number.isFinite(next)) throw new Error('Invalid selected run');
  if (Number.isFinite(current) && current > next) return null;
  if (current !== next) return { model: input.run.model, run: input.run, reason: 'new-run' };
  if (!input.inventoryMatches) return { model: input.run.model, run: input.run, reason: 'backfill' };
  return input.complete ? null : { model: input.run.model, run: input.run, reason: 'repair' };
}
export interface DiagnosticStrategy<T> { id: string; version: string; derive(acquired: AcquisitionResult): T | Promise<T> }
export async function deriveProduct<T>(acquired: AcquisitionResult, strategy: DiagnosticStrategy<T>): Promise<{ value: T; derivation: { id: string; version: string; inputStage: AcquisitionResult['stage'] } }> {
  return { value: await strategy.derive(acquired), derivation: { id: strategy.id, version: strategy.version, inputStage: acquired.stage } };
}
export interface ModelTask<T> { model: string; build(): Promise<T>; lastGood(): Promise<T | null> }
export type ModelOutcome<T> = { model: string; status: 'updated' | 'retained'; value: T; error?: string } | { model: string; status: 'unavailable'; error: string };
/** Build each model independently, using its lastGood result after a failure. An empty task list returns []. */
export async function executeModelTasks<T>(tasks: readonly ModelTask<T>[], concurrency = 1): Promise<ModelOutcome<T>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid model concurrency');
  const results: ModelOutcome<T>[] = new Array(tasks.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    for (;;) {
      const index = cursor++; if (index >= tasks.length) return;
      const task = tasks[index];
      try { results[index] = { model: task.model, status: 'updated', value: await task.build() }; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try { const value = await task.lastGood(); results[index] = value === null ? { model: task.model, status: 'unavailable', error: message } : { model: task.model, status: 'retained', value, error: message }; }
        catch (fallback) { results[index] = { model: task.model, status: 'unavailable', error: `${message}; last-good validation: ${fallback}` }; }
      }
    }
  }));
  return results;
}
