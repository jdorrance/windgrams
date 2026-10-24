// Admin page: lists launches from the repository (through the Worker) and
// creates or updates one launch per save. The Worker commits the change; the
// forecasts and the site rebuild follow automatically.

import { compassPoint, slugify, TIME_ZONES, validateLaunchInput, windLimitDisplayInput, windLimitFromDisplayInput, type Launch } from "../lib/launches.ts";
import { getUnitSystem } from "../lib/units.ts";
import { mountPicker } from "./map.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("admin-status");
const form = $("launch-form") as HTMLFormElement;
const errors = $("form-errors");
const saveStatus = $("save-status");
let launches: Launch[] = [];
let editing: Launch | null = null;
const units = getUnitSystem();
const windFields = ["windMinMph", "windMaxMph", "gustMaxMph"] as const;
let originalWinds: Pick<Launch, "windMinMph" | "windMaxMph" | "gustMaxMph"> = { windMinMph: null, windMaxMph: null, gustMaxMph: null };

interface ApiError {
  error?: string;
  details?: string[];
}
interface ListResponse extends ApiError {
  email: string;
  launches: Launch[];
}
interface SaveResponse extends ApiError {
  commitUrl: string;
}

const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const picker = mountPicker($("picker"), (lat, lon) => {
  field("latitude").value = lat.toFixed(5);
  field("longitude").value = lon.toFixed(5);
}, []);

for (const name of ["latitude", "longitude"]) {
  field(name).addEventListener("change", () => picker.set(Number(field("latitude").value), Number(field("longitude").value)));
}

field("name").addEventListener("input", () => {
  if (!editing) $("slug-hint").textContent = field("name").value ? `Address: /launches/${slugify(field("name").value)}` : "";
});

function setFacing(deg: number | null) {
  const snapped = deg === null ? null : (Math.round(deg / 22.5) * 22.5) % 360;
  for (const input of form.querySelectorAll<HTMLInputElement>('input[name="facing"]')) input.checked = snapped === null ? input.value === "" : Number(input.value) === snapped && input.value !== "";
}

function openForm(launch: Launch | null) {
  editing = launch;
  form.hidden = false;
  errors.replaceChildren();
  saveStatus.textContent = "";
  $("form-title").textContent = launch ? `Edit ${launch.name}` : "Add a launch";
  field("name").value = launch?.name ?? "";
  field("region").value = launch?.region ?? "";
  field("latitude").value = launch ? String(launch.latitude) : "";
  field("longitude").value = launch ? String(launch.longitude) : "";
  field("timeZone").value = launch?.timeZone ?? TIME_ZONES[0];
  field("windArcHalfWidthDeg").value = launch?.windArcHalfWidthDeg == null ? "" : String(launch.windArcHalfWidthDeg);
  originalWinds = { windMinMph: launch?.windMinMph ?? null, windMaxMph: launch?.windMaxMph ?? null, gustMaxMph: launch?.gustMaxMph ?? null };
  for (const name of windFields) {
    const input = field(name) as HTMLInputElement;
    input.value = windLimitDisplayInput(originalWinds[name], units);
    input.max = String({ windMinMph: 40, windMaxMph: 50, gustMaxMph: 60 }[name] * (units === "metric" ? 1.609344 : 1));
  }
  field("notes").value = launch?.notes ?? "";
  if (launch) setFacing(launch.facingDeg);
  else setFacing(null);
  $("slug-hint").textContent = launch ? `Address: /launches/${launch.slug}` : "";
  picker.invalidate();
  if (launch) picker.set(launch.latitude, launch.longitude);
  else picker.clear();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  field("name").focus({ preventScroll: true });
}

function renderList() {
  const rows = $("launch-rows");
  rows.replaceChildren();
  for (const launch of launches) {
    const tr = document.createElement("tr");
    const cells = [
      launch.name,
      launch.slug,
      `${launch.latitude.toFixed(4)}, ${launch.longitude.toFixed(4)}`,
      launch.facingDeg === null ? "Unknown" : `${compassPoint(launch.facingDeg)}${launch.windArcHalfWidthDeg === null ? "" : ` ±${launch.windArcHalfWidthDeg}°`}`,
      `${windLimitDisplayInput(launch.windMinMph, units) || "—"}–${windLimitDisplayInput(launch.windMaxMph, units) || "—"}, gust ${windLimitDisplayInput(launch.gustMaxMph, units) || "—"}`,
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i < 2) td.className = "text";
      tr.appendChild(td);
    });
    const td = document.createElement("td");
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button secondary";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openForm(launch));
    td.appendChild(edit);
    tr.appendChild(td);
    rows.appendChild(tr);
  }
}

async function load() {
  let response: Response;
  try {
    response = await fetch("/api/admin/launches", { headers: { accept: "application/json" } });
  } catch {
    status.textContent = "Admin API unavailable.";
    return;
  }
  const body = (await response.json().catch(() => ({}))) as ListResponse;
  if (response.status === 401 || response.status === 403) {
    status.textContent = "Admin sign-in required.";
    return;
  }
  if (!response.ok) {
    status.textContent = `Admin API: ${body.error ?? response.status}.`;
    return;
  }
  launches = body.launches;
  status.textContent = `Signed in as ${body.email}.`;
  $("list-card").hidden = false;
  renderList();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errors.replaceChildren();
  const facing = form.querySelector<HTMLInputElement>('input[name="facing"]:checked');
  const input = {
    name: field("name").value,
    slug: editing?.slug,
    region: field("region").value,
    latitude: field("latitude").value,
    longitude: field("longitude").value,
    timeZone: field("timeZone").value,
    facingDeg: facing ? facing.value : "",
    windArcHalfWidthDeg: field("windArcHalfWidthDeg").value,
    windMinMph: windLimitFromDisplayInput(field("windMinMph").value, units, originalWinds.windMinMph),
    windMaxMph: windLimitFromDisplayInput(field("windMaxMph").value, units, originalWinds.windMaxMph),
    gustMaxMph: windLimitFromDisplayInput(field("gustMaxMph").value, units, originalWinds.gustMaxMph),
    notes: field("notes").value,
  };
  const checked = validateLaunchInput(input, units);
  const showErrors = (list: string[]) => {
    for (const message of list) {
      const li = document.createElement("li");
      li.textContent = message;
      errors.appendChild(li);
    }
  };
  if ("errors" in checked) {
    showErrors(checked.errors);
    return;
  }

  const save = $("save") as HTMLButtonElement;
  save.disabled = true;
  saveStatus.textContent = "Saving…";
  try {
    const response = await fetch("/api/admin/launches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: editing ? "update" : "create", launch: checked.launch }),
    });
    const body = (await response.json().catch(() => ({}))) as SaveResponse;
    if (!response.ok) {
      saveStatus.textContent = "";
      showErrors([body.error ?? `Save failed (${response.status}).`, ...(body.details ?? [])]);
      return;
    }
    const index = launches.findIndex((l) => l.slug === checked.launch.slug);
    if (index >= 0) launches[index] = checked.launch;
    else launches.push(checked.launch);
    renderList();
    editing = checked.launch;
    originalWinds = { windMinMph: editing.windMinMph, windMaxMph: editing.windMaxMph, gustMaxMph: editing.gustMaxMph };
    saveStatus.textContent = "";
    const link = document.createElement("a");
    link.href = body.commitUrl;
    link.textContent = "View change";
    saveStatus.append("Saved · publishing… ", link);
  } finally {
    save.disabled = false;
  }
});

$("new-launch").addEventListener("click", () => openForm(null));
// Old errors describe values that are being edited; clear them as soon as the form changes.
form.addEventListener("input", () => errors.replaceChildren());
$("cancel").addEventListener("click", () => {
  form.hidden = true;
  editing = null;
});

load();
