import { assessForecastFreshness, type ForecastFreshnessInput } from '@windgrams/data-client';

type Input = Omit<ForecastFreshnessInput, 'now'>;
interface NoticeEnvironment {
  now(): number;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(timer: number): void;
  window: EventTarget;
  document: EventTarget & { readonly hidden: boolean };
}

/** Keep critical freshness visible and reassess when time passes or a page resumes. */
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
    host.textContent = assessment?.reason ?? '';
    host.hidden = !assessment || assessment.status === 'current';
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
