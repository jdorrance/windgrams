export interface PageLifecycleOptions {
  onSuspend?: () => void;
  onRestore?: () => void;
}

/** Retain cached-page resources; release them only when the document is leaving. */
export function createPageLifecycle(options: PageLifecycleOptions = {}, target: EventTarget = window) {
  const controller = new AbortController();
  const cleanup = new Set<() => void>();
  let disposed = false;

  function dispose() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    for (const release of cleanup) release();
    cleanup.clear();
  }

  target.addEventListener('pagehide', event => {
    options.onSuspend?.();
    if (!(event as PageTransitionEvent).persisted) dispose();
  }, { signal: controller.signal });
  target.addEventListener('pageshow', event => {
    if ((event as PageTransitionEvent).persisted) options.onRestore?.();
  }, { signal: controller.signal });

  return {
    signal: controller.signal,
    get disposed() { return disposed; },
    onDispose(release: () => void) {
      if (disposed) release();
      else cleanup.add(release);
    },
    dispose,
  };
}
