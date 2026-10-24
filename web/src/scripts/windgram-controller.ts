import type { ModelCapabilities, SiteForecast } from '@azohra/meteo.briefing/contract';
import { buildWindgramView, type WindgramOptions, type WindgramView } from '../lib/windgram-view.ts';
import { windgramViewport } from '../lib/windgram-viewport.ts';
import { mountWindgramInspector, renderWindgramDiagnosticsSvg, renderWindgramKey, renderWindgramSvg } from '../lib/windgram-chart.ts';
import { getUnitSystem, type UnitSystem } from '../lib/units.ts';

/**
 * Coordinates asynchronous keyed loads with out-of-order completion protection
 * and retryable failure semantics (failed loads are not permanently poisoned when
 * a user re-selects the same key).
 */
export interface KeyedAsyncLoaderOptions<K, V> {
  load: (key: K) => Promise<V | null>;
  onActiveComplete?: (key: K, value: V | null, error: unknown) => void;
}

export function createKeyedAsyncLoader<K, V>(options: KeyedAsyncLoaderOptions<K, V>) {
  // The resource owner supplies its bounded cache through load(). Keep only
  // active requests here so an evicted resource can be fetched again.
  const inFlight = new Map<K, Promise<V | null>>();
  const failed = new Set<K>();
  let activeKey: K | undefined;
  let selectionToken = 0;
  let disposed = false;

  async function select(key: K): Promise<V | null> {
    if (disposed) return null;
    activeKey = key;
    const token = ++selectionToken;
    // Re-selecting a previously failed key clears its error state so a retry is attempted.
    failed.delete(key);

    let pending = inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          // Install the in-flight record before invoking load, including when
          // a custom loader throws synchronously.
          await Promise.resolve();
          if (disposed) return null;
          const result = await options.load(key);
          if (disposed) return null;
          if (result !== null) {
            failed.delete(key);
          } else {
            failed.add(key);
          }
          return result;
        } catch (err) {
          if (!disposed) failed.add(key);
          throw err;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, pending);
    }

    let value: V | null = null;
    let error: unknown = null;
    try { value = await pending; }
    catch (failure) { error = failure; }
    if (!disposed && token === selectionToken && activeKey === key) {
      options.onActiveComplete?.(key, value, error);
    }
    return value;
  }

  return {
    select,
    isPending(key: K): boolean {
      return inFlight.has(key);
    },
    hasFailed(key: K): boolean {
      return failed.has(key);
    },
    invalidate(key: K): void {
      failed.delete(key);
    },
    getActiveKey(): K | undefined {
      return activeKey;
    },
    dispose(): void {
      disposed = true;
      selectionToken += 1;
      inFlight.clear();
      failed.clear();
    },
  };
}

export interface WindgramControllerElements {
  host: HTMLElement;
  axisHost: HTMLElement;
  keyHost: HTMLElement;
  fullProfileButton: HTMLElement;
  diagnosticsHost?: HTMLElement | null;
  detailsElement?: HTMLDetailsElement | null;
}

export interface WindgramRenderRequest {
  cacheKey?: string | number;
  profile: SiteForecast;
  timeZone: string;
  hours: SiteForecast['hours'];
  selectedValidAt: string | null;
  fullProfile: boolean;
  idPrefix: string;
  launch: WindgramOptions['launch'];
  launchWindows?: WindgramOptions['launchWindows'];
  unitSystem?: UnitSystem;
  capabilities?: ModelCapabilities;
  desktopWidthPx?: number;
  constrainPortraitHeight?: boolean;
  cursorStyle?: {
    fill: string;
    fillOpacity: number;
    stroke: string;
  };
  onSelectHour: (validAt: string) => void;
}

export function createWindgramController(elements: WindgramControllerElements) {
  const { host, axisHost, keyHost, fullProfileButton, diagnosticsHost, detailsElement } = elements;
  let clearInspector: (() => void) | null = null;
  let currentView: WindgramView | null = null;
  let currentLayoutKey = '';
  let currentSelectedValidAt: string | null = null;
  let cursorRect: SVGRectElement | null = null;
  const syncedScrollPositions = new WeakMap<HTMLElement, number>();
  const abortController = new AbortController();

  function syncDiagnosticsScroll(from: HTMLElement, to: HTMLElement) {
    if (!detailsElement || !diagnosticsHost) return;
    if (detailsElement.hidden || !detailsElement.open || to.clientWidth === 0) return;
    if (from.scrollWidth <= from.clientWidth + 1 || to.scrollWidth <= to.clientWidth + 1) return;
    const offset = Number(to.dataset.plotLeft ?? 0) - Number(from.dataset.plotLeft ?? 0);
    const wanted = from.scrollLeft === 0 ? 0 : from.scrollLeft + offset;
    const next = Math.max(0, Math.min(to.scrollWidth - to.clientWidth, wanted));
    if (Math.abs(to.scrollLeft - next) < 0.5) return;
    to.scrollLeft = next;
    syncedScrollPositions.set(to, to.scrollLeft);
  }

  if (diagnosticsHost && detailsElement) {
    for (const [from, to] of [[host, diagnosticsHost], [diagnosticsHost, host]] as const) {
      from.addEventListener(
        'scroll',
        () => {
          const syncedPosition = syncedScrollPositions.get(from);
          syncedScrollPositions.delete(from);
          if (syncedPosition !== undefined && Math.abs(from.scrollLeft - syncedPosition) < 0.5) return;
          syncDiagnosticsScroll(from, to);
        },
        { passive: true, signal: abortController.signal },
      );
    }
    detailsElement.addEventListener(
      'toggle',
      () => {
        syncDiagnosticsScroll(host, diagnosticsHost);
      },
      { signal: abortController.signal },
    );
  }

  function clear() {
    clearInspector?.();
    clearInspector = null;
    currentView = null;
    currentLayoutKey = '';
    currentSelectedValidAt = null;
    cursorRect = null;
    axisHost.replaceChildren();
    axisHost.hidden = true;
    keyHost.replaceChildren();
    diagnosticsHost?.replaceChildren();
    if (detailsElement) detailsElement.hidden = true;
  }

  function select(validAt: string | null, reveal = false, rebuilt = false) {
    if (!currentView) return;
    const idx = validAt ? currentView.hours.findIndex(hour => hour.validAt === validAt) : -1;
    const displayedHour = idx >= 0 ? currentView.hours[idx] : undefined;
    currentView.selectedHourIndex = Math.max(0, idx);
    cursorRect?.setAttribute('visibility', displayedHour ? 'visible' : 'hidden');
    if (cursorRect && displayedHour) {
      const left = displayedHour.x - currentView.columnWidth / 2;
      cursorRect.setAttribute('x', String(left));
      const axisWidth = Number(host.dataset.axisWidth ?? 0);
      if (axisWidth > 0 && reveal) {
        if (left < host.scrollLeft + axisWidth) host.scrollLeft = Math.max(0, left - axisWidth);
        else if (left + currentView.columnWidth > host.scrollLeft + host.clientWidth) {
          host.scrollLeft = left + currentView.columnWidth - host.clientWidth;
        }
      } else if (
        host.scrollWidth > host.clientWidth + 1 &&
        (rebuilt || currentSelectedValidAt !== validAt) &&
        reveal
      ) {
        const right = left + currentView.columnWidth;
        if (left < host.scrollLeft + currentView.left + 16) {
          host.scrollLeft = Math.max(0, left - currentView.left - 16);
        } else if (right > host.scrollLeft + host.clientWidth - 16) {
          host.scrollLeft = right - host.clientWidth + 16;
        }
      }
    }
    currentSelectedValidAt = validAt;
    if (validAt) host.dataset.validAt = validAt;
  }

  function render(req: WindgramRenderRequest): WindgramView {
    const unitSystem = req.unitSystem ?? getUnitSystem();
    const { compact, portrait, height: heightPx } = windgramViewport();
    fullProfileButton.hidden = !compact;
    fullProfileButton.setAttribute('aria-pressed', String(req.fullProfile));
    const widthPx = compact
      ? Math.max(host.clientWidth || 320, 240)
      : req.desktopWidthPx ?? Math.max(host.clientWidth || 640, 240);
    const layoutKey =
      req.cacheKey !== undefined
        ? `${req.cacheKey}:${unitSystem}:${compact ? `compact:${widthPx}:${heightPx}:${req.fullProfile}` : `desktop:${widthPx}`}:${req.launch?.elevationM}:${req.launch?.name}:${req.hours[0]?.validAt}:${req.hours.at(-1)?.validAt}`
        : '';

    const rebuilt = !layoutKey || layoutKey !== currentLayoutKey || !currentView;
    if (rebuilt) {
      clearInspector?.();
      currentLayoutKey = layoutKey;
      const chartTop = req.constrainPortraitHeight ? host.getBoundingClientRect().top + window.scrollY : 0;
      currentView = buildWindgramView(req.profile, {
        timeZone: req.timeZone,
        hours: req.hours,
        launch: req.launch,
        launchWindows: req.launchWindows,
        capabilities: req.capabilities,
        unitSystem,
        widthPx,
        compact,
        heightRange: req.fullProfile ? 'full' : 'soaring',
        heightPx,
        maxHeightPx: req.constrainPortraitHeight && compact && portrait ? heightPx - chartTop - 16 : undefined,
      });
      host.innerHTML = renderWindgramSvg(currentView, { idPrefix: req.idPrefix });
      if (diagnosticsHost) {
        diagnosticsHost.innerHTML = renderWindgramDiagnosticsSvg(currentView, {
          idPrefix: `${req.idPrefix}-details`,
        });
        diagnosticsHost.dataset.plotLeft = String(compact ? 102 : currentView.left);
      }
      if (detailsElement) detailsElement.hidden = false;
      keyHost.innerHTML = renderWindgramKey(currentView.unitSystem);
      axisHost.replaceChildren();
      axisHost.hidden = true;
      host.dataset.columnWidth = String(currentView.columnWidth);
      host.dataset.plotLeft = String(currentView.left);
      host.dataset.axisWidth = '0';

      for (const svg of [host.querySelector('svg'), diagnosticsHost?.querySelector('svg')]) {
        const box = svg?.viewBox.baseVal;
        if (svg && box && box.width > 0) svg.style.width = `${box.width}px`;
      }

      const cursorStyle = req.cursorStyle ?? {
        fill: '#237e81',
        fillOpacity: 0.08,
        stroke: '#237e81',
      };
      cursorRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      for (const [k, v] of Object.entries({
        y: currentView.top,
        height: currentView.plotHeight,
        width: currentView.columnWidth,
        fill: cursorStyle.fill,
        'fill-opacity': cursorStyle.fillOpacity,
        stroke: cursorStyle.stroke,
        'stroke-width': 2,
        'pointer-events': 'none',
        'data-selected-hour': '',
      })) {
        cursorRect.setAttribute(k, String(v));
      }
      const chartSvg = host.querySelector('svg')!;
      chartSvg.insertBefore(cursorRect, chartSvg.querySelector('[data-windgram-cursor]'));
      clearInspector = mountWindgramInspector(host, null, currentView, req.onSelectHour);
    }

    select(req.selectedValidAt, true, rebuilt);
    if (diagnosticsHost) syncDiagnosticsScroll(host, diagnosticsHost);
    return currentView!;
  }

  function dispose() {
    clear();
    abortController.abort();
  }

  return {
    render,
    select,
    clear,
    dispose,
    getView(): WindgramView | null {
      return currentView;
    },
  };
}
