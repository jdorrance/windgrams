import { convertQuantity, defaultQuantityDigits, fmt, formatQuantity, getUnitSystem, isQuantityKind, isUnitSystem, setUnitSystem, unitLabel } from "../lib/units.ts";

const system = getUnitSystem();
const persisted = setUnitSystem(system);
document.documentElement.dataset.units = system;
const select = document.getElementById("unit-system") as HTMLSelectElement | null;
if (select) {
  select.value = system;
  select.addEventListener("change", () => {
    if (!isUnitSystem(select.value)) return;
    const saved = setUnitSystem(select.value);
    const url = new URL(window.location.href);
    if (saved) url.searchParams.delete("units");
    else url.searchParams.set("units", select.value);
    if (url.href === window.location.href) window.location.reload();
    else window.location.assign(url.href);
  });
}

function formatElement(element: HTMLElement) {
  const kind = element.dataset.unit;
  if (isQuantityKind(kind)) {
    const raw = element.dataset.value;
    const value = raw == null || raw.trim() === "" ? null : Number(raw);
    const requestedDigits = element.dataset.digits;
    const digits = requestedDigits !== undefined && /^\d+$/.test(requestedDigits)
      ? Math.min(10, Number(requestedDigits)) : defaultQuantityDigits(kind, system);
    const converted = convertQuantity(value, kind, system);
    const text = (element.hasAttribute("data-unit-number")
      ? converted === null ? "—" : fmt(converted, digits)
      : formatQuantity(value, kind, digits, system)) + (element.dataset.unitSuffix ?? "");
    if (element.textContent !== text) element.textContent = text;
  }
  const label = element.dataset.unitLabel;
  if (isQuantityKind(label)) {
    const text = unitLabel(label, system);
    if (element.textContent !== text) element.textContent = text;
  }
  // With all browser storage blocked, carry the preference between site pages.
  // Forecast/model/time query parameters and anchors remain intact.
  if (!persisted && element instanceof HTMLAnchorElement && element.hasAttribute("href") && !element.hasAttribute("download")) {
    const url = new URL(element.href, window.location.href);
    if (url.origin === window.location.origin && !/\.[^/]+$/.test(url.pathname) && !/\/(?:api|data)\//.test(url.pathname)) {
      url.searchParams.set("units", system);
      if (element.href !== url.href) element.href = url.href;
    }
  }
}

function formatTree(root: ParentNode) {
  if (root instanceof HTMLElement) formatElement(root);
  for (const element of root.querySelectorAll<HTMLElement>("[data-unit], [data-unit-label], a[href]")) formatElement(element);
}

formatTree(document);
new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === "attributes" && mutation.target instanceof HTMLElement) formatElement(mutation.target);
    for (const node of mutation.addedNodes) if (node instanceof HTMLElement) formatTree(node);
  }
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-unit", "data-value", "data-digits", "data-unit-number", "data-unit-suffix", "data-unit-label", "href"] });
