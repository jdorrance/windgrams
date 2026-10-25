import { assessForecastFreshness, type ForecastFreshnessInput } from '@windgrams/data-client';
import type { ProviderRefresh } from '@windgrams/contracts/provider-health';

type Input = Omit<ForecastFreshnessInput, 'now'> & { refresh?: ProviderRefresh | null };
interface NoticeEnvironment {
  now(): number;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(timer: number): void;
  window: EventTarget;
  document: EventTarget & { readonly hidden: boolean };
}

/** Keep forecast age and refresh failures visible; reassess age when time passes or a page resumes. */
export function createFreshnessNotice(
  host: HTMLElement,
  read: () => Input | null,
  signal: AbortSignal,
  environment: NoticeEnvironment = { now: Date.now, setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), window, document },
) {
  let timer: number | undefined;
  const stop = () => { if (timer !== undefined) environment.clearTimeout(timer); timer = undefined; };
  const refresh = () => {
    stop();
    if (signal.aborted) return;
    const input = read();
    const now = environment.now();
    const assessment = input ? assessForecastFreshness({ ...input, now: new Date(now).toISOString() }) : null;
    const failedRefresh = !input?.historical && ['retained', 'unavailable'].includes(input?.refresh?.outcome ?? '');
    host.textContent = [assessment?.reason, failedRefresh ? 'Latest update failed' : ''].filter(Boolean).join(' · ');
    host.hidden = !host.textContent;
    host.dataset.freshness = assessment?.status ?? '';
    if (!environment.document.hidden && assessment?.nextCheckAt) {
      timer = environment.setTimeout(refresh, Math.min(2_147_483_647, Math.max(1, Date.parse(assessment.nextCheckAt) - now)));
    }
  };
  const options = { signal };
  environment.window.addEventListener('pagehide', stop, options);
  environment.window.addEventListener('pageshow', refresh, options);
  environment.document.addEventListener('visibilitychange', refresh, options);
  signal.addEventListener('abort', stop, { once: true });
  return { refresh };
}
