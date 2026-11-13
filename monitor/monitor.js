"use strict";

const interval = 15_000;
const sampleCount = 8;
const metrics = {
  rsrp: { label: "RSRP", unit: "дБм", threshold: -100, ticks: [-70, -85, -100, -115] },
  sinr: { label: "SINR", unit: "дБ", threshold: 5, ticks: [25, 15, 5, -5] },
};
const zones = [
  { id: "A1", name: "Верхний проход", rsrp: -89, sinr: 15 },
  { id: "A2", name: "Центральный проход", rsrp: -91, sinr: 12 },
  { id: "A3", name: "Нижний проход", rsrp: -85, sinr: 18 },
  { id: "A4", name: "Энергомодуль", rsrp: -93, sinr: 10 },
  { id: "A5", name: "Технологический тамбур", rsrp: -82, sinr: 20 },
];
const variation = [0, 2, 1, -1, -2, 1, 0, -1];
const statusLabels = { good: "Норма", warning: "Деградация", critical: "Нет данных" };
const severityLabels = { warning: "Предупреждение", critical: "Критическая" };
const alarmTypes = {
  "rf-off": { title: "Репитер отключён", detail: "RF выключен в тестовом сценарии.", level: "critical" },
  "low-signal": { title: "Сигнал ниже порога", detail: "Три последовательных отсчёта с низким RSRP или SINR.", level: "warning" },
  "no-telemetry": { title: "Потеря телеметрии", detail: "Зонд не передаёт данные более 60 секунд.", level: "critical" },
};
const alarmSources = new Map([["R1", "R1 · Репитер"], ...zones.map(zone =>
  [zone.id, `${zone.id} · ${zone.name}`])]);
const historyStorageKey = "mdpc.monitor.alarmHistory.v1";
const elements = Object.fromEntries([
  "scenario", "refresh", "summary", "zones", "chart", "trend-title",
  "alarms", "alarm-count", "updated", "announcement",
  "floor-map", "repeater-marker", "zone-details",
  "history-zone", "history-level", "history-rows", "history-count", "history-storage", "history-export",
  "history-status", "history-from", "history-to",
].map(id => [id, document.getElementById(id)]));
const metricButtons = document.querySelectorAll("[data-metric]");
const mapMarkers = new Map(Array.from(elements["floor-map"].querySelectorAll("[data-zone]"),
  button => [button.dataset.zone, button]));
const timeFormat = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const historyTimeFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const savedHistory = loadAlarmHistory();
const alarmHistory = savedHistory.entries;
const openAlarms = new Map(alarmHistory.filter(entry => entry.recoveredAt === null)
  .map(entry => [alarmKey(entry), entry]));

let scenario = savedHistory.scenario;
elements.scenario.value = scenario;
let selectedZone = "A2";
let selectedMetric = "rsrp";
let samples = [];
let sequence = 0;
let lastSeen = new Map();
let timer;

function alarmKey({ sourceId, type }) {
  return `${sourceId}/${type}`;
}

function alarmDetails(sourceId, type) {
  return { sourceId, type, source: alarmSources.get(sourceId), ...alarmTypes[type] };
}

function validTime(value) {
  return Number.isFinite(value) && Math.abs(value) <= 8.64e15;
}

function loadAlarmHistory() {
  const fallback = { entries: [], scenario: elements.scenario.value };
  try {
    const saved = JSON.parse(localStorage.getItem(historyStorageKey));
    if (!saved || !Array.isArray(saved.entries)) return fallback;
    const entries = [];
    const activeKeys = new Set();
    for (const entry of saved.entries) {
      if (!entry || !alarmSources.has(entry.sourceId) || !Object.hasOwn(alarmTypes, entry.type)) continue;
      const { sourceId, type, occurredAt, recoveredAt } = entry;
      if ((sourceId === "R1") !== (type === "rf-off")) continue;
      if (!validTime(occurredAt) || (recoveredAt !== null && (!validTime(recoveredAt) || recoveredAt < occurredAt))) continue;
      if (recoveredAt === null) {
        const key = alarmKey(entry);
        if (activeKeys.has(key)) continue;
        activeKeys.add(key);
      }
      entries.push({ ...alarmDetails(sourceId, type), occurredAt, recoveredAt });
    }
    const hasScenario = Array.from(elements.scenario.options).some(option => option.value === saved.scenario);
    return { entries, scenario: hasScenario ? saved.scenario : fallback.scenario };
  } catch {
    return fallback;
  }
}

function saveAlarmHistory() {
  const notice = elements["history-storage"];
  try {
    const entries = alarmHistory.map(({ sourceId, type, occurredAt, recoveredAt }) =>
      ({ sourceId, type, occurredAt, recoveredAt }));
    localStorage.setItem(historyStorageKey, JSON.stringify({ entries, scenario }));
    notice.textContent = "История тестовых событий сохраняется в этом браузере.";
  } catch {
    notice.textContent = "Хранилище браузера недоступно. Новые записи сохраняются до перезагрузки.";
  }
}

function sampleZone(zone, index) {
  if (scenario === "offline" || (scenario === "mixed" && zone.id === "A5" && index >= 3)) {
    return null;
  }
  const drift = variation[(index + Number(zone.id.slice(1))) % variation.length];
  if (scenario === "mixed" && zone.id === "A2" && index >= 3) {
    return { rsrp: -105 + drift, sinr: 2 + drift };
  }
  return { rsrp: zone.rsrp + drift, sinr: zone.sinr + drift };
}

function makeSample(index, time) {
  const readings = zones.map(zone => {
    const reading = sampleZone(zone, index);
    if (reading) lastSeen.set(zone.id, time);
    return [zone.id, reading];
  });
  return { time, zones: Object.fromEntries(readings) };
}

function belowThreshold(reading) {
  return reading && Object.keys(metrics).some(metric => reading[metric] < metrics[metric].threshold);
}

function zoneStatus(zone) {
  const current = samples.at(-1).zones[zone.id];
  if (!current) return "critical";
  return samples.slice(-3).every(sample => belowThreshold(sample.zones[zone.id]))
    ? "warning" : "good";
}

function formatValue(value) {
  return value == null ? "—" : String(value).replace("-", "−");
}

function statusBadge(status) {
  return `<span class="status ${status}"><i aria-hidden="true"></i>${statusLabels[status]}</span>`;
}

function tile(title, value, detail, tone = "", unit = "") {
  return `<div class="tile"><span>${title}</span><strong class="${tone}">${value}${unit ? ` <small>${unit}</small>` : ""}</strong><small>${detail}</small></div>`;
}

function renderSummary(states) {
  const online = scenario !== "offline";
  const drift = variation[(sequence - 1) % variation.length];
  const healthy = states.filter(state => state.status === "good").length;
  elements.summary.innerHTML = [
    tile("Репитер R1", online ? "В работе" : "Отключён", "RF · Comba mPICO", online ? "good" : "critical"),
    tile("RSRP донора", formatValue(-78 + drift), "Наружный зонд M1", "", "дБм"),
    tile("SINR донора", formatValue(17 + drift), "Наружный зонд M1", "", "дБ"),
    tile("Зоны в норме", `${healthy} из ${zones.length}`, "По последним отсчётам", healthy === zones.length ? "good" : "warning"),
  ].join("");
}

function renderZones(states) {
  const focusedZone = elements.zones.contains(document.activeElement) ? document.activeElement.dataset.zone : null;
  const latest = samples.at(-1);
  elements.zones.innerHTML = states.map(({ zone, status }) => {
    const selected = zone.id === selectedZone;
    const reading = latest.zones[zone.id];
    const values = Object.entries(metrics).map(([key, metric]) => {
      const value = reading?.[key];
      const color = value < metric.threshold ? "warning" : "";
      return `<td class="${color}">${formatValue(value)}</td>`;
    }).join("");
    return `<tr class="${selected ? "selected" : ""}">
      <td><button class="zone-button" type="button" data-zone="${zone.id}" aria-pressed="${selected}"><b>${zone.id}</b> ${zone.name}</button></td>
      ${values}<td>${statusBadge(status)}</td>
    </tr>`;
  }).join("");
  if (focusedZone) elements.zones.querySelector(`[data-zone="${focusedZone}"]`)?.focus({ preventScroll: true });
}

function getAlarms(states) {
  const alarms = [];
  if (scenario === "offline") {
    alarms.push(alarmDetails("R1", "rf-off"));
  }
  for (const { zone, status } of states) {
    if (status === "warning") {
      alarms.push(alarmDetails(zone.id, "low-signal"));
    }
    if (status === "critical") {
      const age = samples.at(-1).time - lastSeen.get(zone.id);
      if (age > 60_000) {
        alarms.push(alarmDetails(zone.id, "no-telemetry"));
      }
    }
  }
  return alarms.sort((a, b) => Number(b.level === "critical") - Number(a.level === "critical"));
}

function renderAlarms(alarms) {
  elements["alarm-count"].textContent = alarms.length;
  elements.alarms.innerHTML = alarms.length ? alarms.map(({ source, title, detail, level }) => `
    <li><span class="severity ${level}">${severityLabels[level]}</span>
      <strong>${title}</strong><p>${source}</p><p>${detail}</p></li>`
  ).join("") : '<li><strong class="good">Активных тревог нет</strong><p>Репитер и зонды работают штатно.</p></li>';
}

function updateAlarmHistory(alarms, time) {
  let changed = false;
  const activeKeys = new Set();
  for (const alarm of alarms) {
    const key = alarmKey(alarm);
    activeKeys.add(key);
    if (openAlarms.has(key)) continue;
    const entry = { ...alarm, occurredAt: time, recoveredAt: null };
    alarmHistory.push(entry);
    openAlarms.set(key, entry);
    changed = true;
  }
  for (const [key, entry] of openAlarms) {
    if (!activeKeys.has(key)) {
      entry.recoveredAt = Math.max(entry.occurredAt, time);
      openAlarms.delete(key);
      changed = true;
    }
  }
  return changed;
}

function historyTime(time) {
  return `<time datetime="${new Date(time).toISOString()}">${historyTimeFormat.format(time)}</time>`;
}

function dateInputKey(input) {
  // Date inputs expose a calendar date without the browser's time-zone offset.
  const date = input.valueAsDate;
  return date ? date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate() : null;
}

function filteredAlarmHistory() {
  const source = elements["history-zone"].value;
  const level = elements["history-level"].value;
  const status = elements["history-status"].value;
  const from = dateInputKey(elements["history-from"]);
  const to = dateInputKey(elements["history-to"]);
  const invalidPeriod = from !== null && to !== null && from > to;
  if (invalidPeriod) return { rows: [], invalidPeriod };

  const rows = alarmHistory.filter(entry => {
    if ((source && entry.sourceId !== source) || (level && entry.level !== level)) return false;
    const entryStatus = entry.recoveredAt === null ? "active" : "recovered";
    if (status && entryStatus !== status) return false;
    if (from === null && to === null) return true;
    const date = new Date(entry.occurredAt);
    const day = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
    return (from === null || day >= from) && (to === null || day <= to);
  }).reverse();
  return { rows, invalidPeriod };
}

function renderAlarmHistory() {
  const { rows, invalidPeriod } = filteredAlarmHistory();
  for (const id of ["history-from", "history-to"]) {
    elements[id].setAttribute("aria-invalid", String(invalidPeriod));
  }
  elements["history-export"].disabled = rows.length === 0;
  const count = invalidPeriod ? "Проверьте даты" : `Записей: ${rows.length} из ${alarmHistory.length}`;
  const counter = elements["history-count"];
  if (counter.textContent !== count) counter.textContent = count;
  elements["history-rows"].innerHTML = rows.length ? rows.map(entry => `
    <tr>
      <td><strong>${entry.title}</strong><small>${entry.source}</small></td>
      <td><span class="status ${entry.level}"><i aria-hidden="true"></i>${severityLabels[entry.level]}</span></td>
      <td>${historyTime(entry.occurredAt)}</td>
      <td>${entry.recoveredAt === null ? "Активна" : historyTime(entry.recoveredAt)}</td>
    </tr>`).join("") : `<tr><td colspan="4" class="history-empty">${invalidPeriod
      ? "Дата «С» должна быть раньше даты «По» или совпадать с ней."
      : alarmHistory.length ? "Нет записей по выбранным фильтрам." : "Тревоги пока не зарегистрированы."}</td></tr>`;
}

function exportAlarmHistory() {
  const { rows: entries } = filteredAlarmHistory();
  if (entries.length === 0) return;

  const rows = [
    ["Зона или устройство", "Критичность", "Время возникновения (UTC)", "Время восстановления (UTC)"],
    ...entries.map(({ source, level, occurredAt, recoveredAt }) => [
      source,
      severityLabels[level],
      new Date(occurredAt).toISOString(),
      recoveredAt === null ? "" : new Date(recoveredAt).toISOString(),
    ]),
  ];
  const csv = rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(";")).join("\r\n");
  const file = new Blob(["\uFEFF", csv, "\r\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = "mdpc-alarm-history.csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderFloor(states, alarms) {
  const online = scenario !== "offline";
  const repeaterMarker = elements["repeater-marker"];
  repeaterMarker.dataset.status = online ? "good" : "critical";
  repeaterMarker.title = `Репитер R1 · ${online ? "В работе" : "Отключён"}`;
  repeaterMarker.setAttribute("aria-label", repeaterMarker.title);

  for (const { zone, status } of states) {
    const marker = mapMarkers.get(zone.id);
    marker.dataset.status = status;
    marker.title = `${zone.id} · ${zone.name} · ${statusLabels[status]}`;
    marker.setAttribute("aria-label", marker.title);
    marker.setAttribute("aria-pressed", String(zone.id === selectedZone));
  }

  const { zone, status } = states.find(state => state.zone.id === selectedZone);
  const reading = samples.at(-1).zones[zone.id];
  const values = Object.entries(metrics).map(([key, { label, unit }]) => `
    <div><dt>${label}</dt><dd>${formatValue(reading?.[key])}${reading ? ` <small>${unit}</small>` : ""}</dd></div>`
  ).join("");
  const zoneAlarms = alarms.filter(alarm => alarm.sourceId === zone.id);
  const alarmDetails = zoneAlarms.length
    ? `<ul>${zoneAlarms.map(({ title, detail, level }) =>
      `<li><strong class="${level}">${title}</strong><p>${detail}</p></li>`).join("")}</ul>`
    : "<p>Активных тревог нет.</p>";
  elements["zone-details"].innerHTML = `
    <h3 id="zone-details-title">${zone.id} · ${zone.name}</h3>
    ${statusBadge(status)}
    <dl>${values}</dl>
    <h4>Тревоги зоны</h4>
    ${alarmDetails}`;
}

function renderChart() {
  const zone = zones.find(item => item.id === selectedZone);
  const { label, unit, threshold, ticks } = metrics[selectedMetric];
  elements["trend-title"].textContent = `${zone.id} · ${zone.name}`;
  const values = samples.map(sample => sample.zones[zone.id]?.[selectedMetric]);
  if (values.every(value => value == null)) {
    elements.chart.innerHTML = '<p class="chart-empty">За выбранный период показаний нет</p>';
    return;
  }
  const width = Math.max(290, elements.chart.clientWidth);
  const right = width - 6;
  const y = value => 12 + (ticks[0] - value) * 108 / (ticks[0] - ticks.at(-1));
  const x = index => 45 + index * (right - 45) / (sampleCount - 1);
  const grid = ticks.map(value => `
    <line x1="45" x2="${right}" y1="${y(value)}" y2="${y(value)}"
      stroke="${value === threshold ? "#bf9653" : "#3d4944"}" stroke-dasharray="${value === threshold ? "5 4" : "none"}"/>
    <text x="0" y="${y(value) + 4}">${formatValue(value)}</text>`
  ).join("");
  const path = values.map((value, index) => {
    if (value == null) return "";
    const command = index > 0 && values[index - 1] != null ? "L" : "M";
    return `${command}${x(index)},${y(value)}`;
  }).join(" ");
  const points = values.map((value, index) => value == null ? "" : `
    <circle cx="${x(index)}" cy="${y(value)}" r="3" fill="#bbf487">
      <title>${timeFormat.format(samples[index].time)} · ${formatValue(value)} ${unit}</title>
    </circle>`).join("");
  const description = values.map(formatValue).join(", ");
  elements.chart.innerHTML = `<svg viewBox="0 0 ${width} 152" role="img"
    aria-label="${label}, ${unit}. Отсчёты: ${description}">
    ${grid}<path d="${path}" fill="none" stroke="#bbf487" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${points}
    <text x="45" y="143">${timeFormat.format(samples[0].time)}</text>
    <text x="${right}" y="143" text-anchor="end">${timeFormat.format(samples.at(-1).time)}</text>
  </svg>`;
}

function render({ recordAlarms = false, scenarioChanged = false } = {}) {
  const states = zones.map(zone => ({ zone, status: zoneStatus(zone) }));
  const alarms = getAlarms(states);
  renderSummary(states);
  renderFloor(states, alarms);
  renderZones(states);
  renderAlarms(alarms);
  renderChart();
  const time = new Date(samples.at(-1).time);
  if (recordAlarms) {
    const historyChanged = updateAlarmHistory(alarms, time.getTime());
    if (historyChanged || scenarioChanged) saveAlarmHistory();
    renderAlarmHistory();
  }
  elements.updated.dateTime = time.toISOString();
  elements.updated.textContent = `Обновлено в ${timeFormat.format(time)}`;
}

function reset() {
  const now = Date.now();
  lastSeen = new Map(zones.map(zone => [zone.id, now - sampleCount * interval]));
  samples = Array.from({ length: sampleCount }, (_, index) =>
    makeSample(index, now - (sampleCount - 1 - index) * interval));
  sequence = sampleCount;
  render({ recordAlarms: true, scenarioChanged: true });
  restartTimer();
}

function nextSample() {
  samples = [...samples.slice(1), makeSample(sequence, Date.now())];
  sequence += 1;
  render({ recordAlarms: true });
}

function restartTimer() {
  clearInterval(timer);
  timer = setInterval(nextSample, interval);
}

elements.scenario.addEventListener("change", () => {
  scenario = elements.scenario.value;
  reset();
  elements.announcement.textContent = "Тестовый сценарий изменён.";
});
elements.refresh.addEventListener("click", () => {
  nextSample();
  restartTimer();
  elements.announcement.textContent = elements.updated.textContent;
});
function selectZone(event) {
  const button = event.target.closest("[data-zone]");
  if (!button) return;
  selectedZone = button.dataset.zone;
  render();
  elements.announcement.textContent = elements["zone-details"].innerText;
}

elements.zones.addEventListener("click", selectZone);
elements["floor-map"].addEventListener("click", selectZone);
const historyZone = elements["history-zone"];
historyZone.add(new Option("R1 · Репитер", "R1"));
for (const zone of zones) {
  historyZone.add(new Option(`${zone.id} · ${zone.name}`, zone.id));
}
historyZone.addEventListener("change", renderAlarmHistory);
elements["history-level"].addEventListener("change", renderAlarmHistory);
elements["history-status"].addEventListener("change", renderAlarmHistory);
elements["history-from"].addEventListener("input", renderAlarmHistory);
elements["history-to"].addEventListener("input", renderAlarmHistory);
elements["history-export"].addEventListener("click", exportAlarmHistory);
for (const button of metricButtons) {
  button.addEventListener("click", () => {
    selectedMetric = button.dataset.metric;
    for (const option of metricButtons) {
      option.setAttribute("aria-pressed", String(option === button));
    }
    renderChart();
  });
}
reset();
new ResizeObserver(renderChart).observe(elements.chart);
