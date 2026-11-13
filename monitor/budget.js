"use strict";

const bands = {
  B1: { min: 2110, max: 2170, duplex: 190, widths: [5, 10, 15, 20] },
  B3: { min: 1805, max: 1880, duplex: 95, widths: [1.4, 3, 5, 10, 15, 20] },
  B7: { min: 2620, max: 2690, duplex: 120, widths: [5, 10, 15, 20] },
};
const blocks = { 1.4: 6, 3: 15, 5: 25, 10: 50, 15: 75, 20: 100 };
const cableLosses = [[1800, 15.6], [2000, 16], [2200, 17.3], [2500, 18.6], [2700, 19.7]];
const format = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "always" });
const carrierRows = document.getElementById("carrier-rows");
const errors = document.getElementById("budget-errors");
const settingsKey = "mdpc.monitor.budgetSettings.v1";

function loadBudgetSettings() {
  try {
    return JSON.parse(localStorage.getItem(settingsKey)) ?? {};
  } catch {
    return {};
  }
}

function setWidths(select, band, selected) {
  select.replaceChildren(...band.widths.map(width => new Option(String(width), String(width))));
  select.value = band.widths.includes(selected) ? selected : 10;
}

function carrierRow(operator) {
  const row = document.createElement("tr");
  row.innerHTML = `
    <th scope="row"></th>
    <td><select data-field="band">${Object.keys(bands).map(band => `<option>${band}</option>`).join("")}</select></td>
    <td><input data-field="frequency" type="number" step="any" aria-describedby="frequency-hint"></td>
    <td><select data-field="width"></select></td>
    <td><input data-field="power" type="number" step="any" required></td>`;
  row.querySelector("th").textContent = operator.name;
  const fields = Object.fromEntries(Array.from(row.querySelectorAll("[data-field]"),
    element => [element.dataset.field, element]));
  for (const [key, label] of Object.entries({ band: "Диапазон", frequency: "Частота DL, МГц", width: "Ширина, МГц", power: "Мощность, дБм" })) {
    fields[key].setAttribute("aria-label", `${operator.name}: ${label}`);
  }
  fields.band.value = operator.band;
  fields.frequency.value = operator.dl_mhz ?? "";
  fields.power.value = operator.das_dl_dbm;
  setWidths(fields.width, bands[operator.band], operator.bandwidth_mhz);
  return { row, fields, name: operator.name };
}

function readCarrier({ fields, name }, problems) {
  const band = bands[fields.band.value];
  const width = Number(fields.width.value);
  const lower = band.min + width / 2;
  const upper = band.max - width / 2;
  fields.frequency.placeholder = `Край ${band.max}`;
  const useEdge = fields.frequency.value === "" && !fields.frequency.validity.badInput;
  const frequency = useEdge ? band.max : fields.frequency.valueAsNumber;
  const power = fields.power.valueAsNumber;
  const frequencyValid = useEdge || (frequency >= lower && frequency <= upper);
  const powerValid = Number.isFinite(power);
  fields.frequency.setAttribute("aria-invalid", String(!frequencyValid));
  fields.power.setAttribute("aria-invalid", String(!powerValid));
  if (!frequencyValid) problems.push(`${name}: частота центра должна быть от ${lower} до ${upper} МГц.`);
  if (!powerValid) problems.push(`${name}: укажите мощность несущей.`);
  return frequencyValid && powerValid
    ? { name, band: fields.band.value, frequency, width, power, useEdge }
    : null;
}

function rsrp(carrier, zone) {
  const cable = cableLosses.find(([upper]) => carrier.frequency <= upper)[1] * zone.cable_m / 100;
  const freeSpace = 32.44 + 20 * Math.log10(carrier.frequency * zone.distance_m / 1000);
  const feeder = zone.splitter_db + 1.2 + cable;
  const referenceCorrection = 10 * Math.log10(12 * blocks[carrier.width]);
  // As in the Python model, 8 dBi panel gain offsets 8 dB handset loss.
  return carrier.power - feeder - freeSpace - zone.zone_loss_db - referenceCorrection;
}

function frequencyRange(center, width) {
  return { low: center - width / 2, high: center + width / 2 };
}

function gsmChannel(band, arfcn) {
  if (!Number.isInteger(arfcn)) return null;
  if (band === "1800") {
    if (arfcn < 512 || arfcn > 885) return null;
    const ul = 1710.2 + 0.2 * (arfcn - 512);
    return { ul, dl: ul + 95 };
  }
  if ((arfcn < 0 || arfcn > 124) && (arfcn < 975 || arfcn > 1023)) return null;
  const ul = 890 + 0.2 * (arfcn > 124 ? arfcn - 1024 : arfcn);
  return { ul, dl: ul + 45 };
}

function renderGsm(carriers) {
  const band = document.getElementById("gsm-band").value;
  const input = document.getElementById("gsm-arfcn");
  const channel = gsmChannel(band, input.valueAsNumber);
  const result = document.getElementById("gsm-result");
  const findings = document.getElementById("gsm-findings");
  document.getElementById("gsm-range").textContent = band === "1800" ? "512–885" : "0–124 или 975–1023";
  input.setAttribute("aria-invalid", String(!channel));
  findings.replaceChildren();
  if (!channel) {
    result.textContent = "Введите допустимый целый ARFCN для выбранного диапазона.";
    return null;
  }

  const signals = carriers.filter(carrier => carrier && !carrier.useEdge).flatMap(carrier => [
    { label: `${carrier.name} DL`, ...frequencyRange(carrier.frequency, carrier.width) },
    { label: `${carrier.name} UL`, ...frequencyRange(carrier.frequency - bands[carrier.band].duplex, carrier.width) },
  ]);
  const targets = [
    { label: "GSM UL", ...frequencyRange(channel.ul, 0.2) },
    { label: "GSM DL", ...frequencyRange(channel.dl, 0.2) },
  ];
  const hits = [];
  function check(signal, type, source) {
    for (const target of targets) {
      const overlap = Math.min(signal.high, target.high) - Math.max(signal.low, target.low);
      if (overlap <= 1e-9) continue;
      hits.push({ type, source, target: target.label, low: signal.low, high: signal.high });
    }
  }
  for (const signal of signals) {
    check(signal, "Прямое перекрытие", signal.label);
    for (const other of signals) {
      if (signal === other) continue;
      check({ low: 2 * signal.low - other.high, high: 2 * signal.high - other.low },
        "IM3", `2 × ${signal.label} − ${other.label}`);
    }
  }
  const missing = carriers.length - signals.length / 2;
  for (const { type, source, target, low, high } of hits) {
    const item = document.createElement("li");
    item.textContent = `${type} · ${source} → ${target} (${format.format(low)}–${format.format(high)} МГц)`;
    findings.append(item);
  }
  const summary = hits.length
    ? `Пересечений: ${hits.length}.`
    : signals.length ? "Для заданных несущих пересечений не найдено." : "Задайте центры LTE-несущих для проверки.";
  result.textContent = `GSM UL ${format.format(channel.ul)} МГц · DL ${format.format(channel.dl)} МГц. ${summary}`
    + (missing ? ` Вне проверки несущих: ${missing} (центр не задан или параметры некорректны).` : "");
  return {
    band: band === "1800" ? "DCS 1800" : "E-GSM 900",
    arfcn: input.valueAsNumber, channel, hits, summary,
    checked: signals.length / 2, missing,
  };
}

function downloadGsm({ band, arfcn, channel, hits, summary, checked, missing }) {
  const headers = ["Диапазон GSM", "ARFCN", "GSM UL, МГц", "GSM DL, МГц",
    "Проверено несущих", "Вне проверки", "Итог", "Тип пересечения",
    "Источник LTE или формула IM3", "Направление GSM", "Нижняя граница, МГц", "Верхняя граница, МГц"];
  const mhz = value => value.toFixed(2).replace(".", ",");
  const prefix = [band, arfcn, mhz(channel.ul), mhz(channel.dl), checked, missing, summary];
  const rows = hits.map(({ type, source, target, low, high }) =>
    [...prefix, type, source, target, mhz(low), mhz(high)]);
  if (!rows.length) rows.push([...prefix, "", "", "", "", ""]);
  downloadCsv("mdpc-gsm-check.csv", headers, rows);
}

function downloadBudget(rows) {
  const headers = ["Оператор", "Зона", "Диапазон LTE", "Частота DL для расчёта, МГц",
    "Режим частоты", "Ширина несущей, МГц", "Мощность на входе DAS, дБм",
    "RSRP, дБм", "Запас до порога, дБ"];
  downloadCsv("mdpc-link-budget.csv", headers, rows);
}

function downloadCsv(filename, headers, rows) {
  const csv = [headers, ...rows].map(row => row.map(value => {
    const field = typeof value === "number" ? String(value).replace(".", ",") : value;
    return `"${field.replaceAll('"', '""')}"`;
  }).join(";")).join("\r\n");
  const file = new Blob(["\uFEFF", csv, "\r\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setup(scenario) {
  const operators = scenario.operators.map(carrierRow);
  carrierRows.replaceChildren(...operators.map(operator => operator.row));
  const gsmBand = document.getElementById("gsm-band");
  const gsmArfcn = document.getElementById("gsm-arfcn");
  const saved = loadBudgetSettings();
  for (const { fields, name } of operators) {
    const carrier = saved.carriers?.[name];
    if (!carrier) continue;
    if (Object.hasOwn(bands, carrier.band)) fields.band.value = carrier.band;
    setWidths(fields.width, bands[fields.band.value], carrier.width ?? Number(fields.width.value));
    if (typeof carrier.frequency === "string") fields.frequency.value = carrier.frequency;
    if (typeof carrier.power === "string") fields.power.value = carrier.power;
  }
  if (saved.gsm?.band === "900" || saved.gsm?.band === "1800") {
    gsmBand.value = saved.gsm.band;
    gsmArfcn.value = typeof saved.gsm.arfcn === "string"
      ? saved.gsm.arfcn
      : gsmBand.value === "1800" ? 698 : 62;
  }

  function saveAndRender() {
    const carriers = Object.fromEntries(operators.map(({ fields, name }) => [name, {
      band: fields.band.value,
      width: Number(fields.width.value),
      frequency: fields.frequency.value,
      power: fields.power.value,
    }]));
    try {
      localStorage.setItem(settingsKey, JSON.stringify({
        carriers, gsm: { band: gsmBand.value, arfcn: gsmArfcn.value },
      }));
    } catch {
      // The calculator remains usable when browser storage is unavailable.
    }
    render();
  }

  const target = scenario.rsrp_target_dbm;
  const reserve = scenario.design_reserve_db;
  document.getElementById("budget-target").textContent =
    `Порог RSRP ${format.format(target)} дБм · требуемый запас ${format.format(reserve)} дБ`;

  const table = document.getElementById("budget-results");
  const header = table.createTHead().insertRow();
  for (const name of ["Зона", ...operators.map(operator => operator.name)]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = name;
    header.append(cell);
  }
  const body = table.createTBody();
  const mapOperator = document.getElementById("budget-operator");
  mapOperator.replaceChildren(...operators.map((operator, index) => new Option(operator.name, index)));
  const markers = document.querySelectorAll("[data-budget-zone]");
  const zoneDetail = document.getElementById("budget-zone-detail");
  let selectedZone = scenario.zones[0].id;
  let mapResults;

  function renderMap() {
    const operator = Number(mapOperator.value);
    for (const marker of markers) {
      const zone = marker.dataset.budgetZone;
      const data = mapResults.get(zone)[operator];
      marker.dataset.status = data ? (data.margin >= reserve ? "good" : "warning") : "unknown";
      marker.setAttribute("aria-pressed", String(zone === selectedZone));
      marker.setAttribute("aria-label", data ? `${zone}, запас ${signed.format(data.margin)} дБ` : `${zone}, нет расчёта`);
    }
    const data = mapResults.get(selectedZone)[operator];
    const name = operators[operator].name;
    zoneDetail.textContent = data
      ? `${name} · ${selectedZone} · RSRP ${format.format(data.value)} дБм · запас ${signed.format(data.margin)} дБ`
      : `${name} · ${selectedZone} · проверьте параметры несущей.`;
  }

  mapOperator.addEventListener("change", renderMap);
  for (const marker of markers) {
    marker.addEventListener("click", () => {
      selectedZone = marker.dataset.budgetZone;
      renderMap();
    });
  }

  const exportButton = document.getElementById("budget-export");
  const gsmExport = document.getElementById("gsm-export");
  let gsmReport = null;
  gsmExport.addEventListener("click", () => {
    if (gsmReport) downloadGsm(gsmReport);
  });
  let exportRows = [];
  exportButton.addEventListener("click", () => downloadBudget(exportRows));

  function render() {
    const problems = [];
    const carriers = operators.map(operator => readCarrier(operator, problems));
    exportRows = [];
    exportButton.disabled = problems.length > 0;
    errors.textContent = problems.join(" ");
    mapResults = new Map(scenario.zones.map(zone => [zone.id, carriers.map(carrier => {
      if (!carrier) return null;
      const value = rsrp(carrier, zone);
      return { value, margin: value - target };
    })]));
    renderMap();
    gsmReport = renderGsm(carriers);
    gsmExport.disabled = !gsmReport;
    let count = 0;
    const resultRows = scenario.zones.map(zone => {
      const row = document.createElement("tr");
      const heading = document.createElement("th");
      heading.scope = "row";
      heading.textContent = zone.id;
      row.append(heading);
      for (const [index, carrier] of carriers.entries()) {
        const cell = row.insertCell();
        if (!carrier) {
          cell.textContent = "—";
          continue;
        }
        const { value, margin } = mapResults.get(zone.id)[index];
        exportRows.push([carrier.name, zone.id, carrier.band, carrier.frequency,
          carrier.useEdge ? "Верхняя граница" : "Центр несущей", carrier.width, carrier.power,
          value.toFixed(2).replace(".", ","), margin.toFixed(2).replace(".", ",")]);
        if (margin >= reserve) count += 1;
        cell.className = margin >= reserve ? "good" : "warning";
        cell.innerHTML = `<strong class="budget-result-value">${format.format(value)} дБм</strong>
          <small class="budget-result-reserve">Запас ${signed.format(margin)} дБ</small>`;
      }
      return row;
    });
    body.replaceChildren(...resultRows);

    const total = document.getElementById("budget-total");
    const summary = document.getElementById("budget-summary");
    if (carriers.some(carrier => carrier === null)) {
      total.textContent = "";
      summary.textContent = "Общий итог и экспорт CSV доступны после исправления параметров всех несущих.";
      return;
    }
    const peak = Math.max(...carriers.map(carrier => carrier.power));
    const combined = peak + 10 * Math.log10(carriers.reduce((sum, carrier) =>
      sum + 10 ** ((carrier.power - peak) / 10), 0));
    total.textContent = `Суммарная мощность DL на DAS ${signed.format(combined)} дБм`;
    summary.textContent = `Расчётная цель достигнута в ${count} из ${operators.length * scenario.zones.length} сочетаний оператор × зона.`;
  }

  for (const { fields } of operators) {
    fields.band.addEventListener("input", () => {
      setWidths(fields.width, bands[fields.band.value], Number(fields.width.value));
    });
  }
  const form = document.getElementById("budget-carriers");
  form.addEventListener("submit", event => event.preventDefault());
  form.addEventListener("input", saveAndRender);
  gsmBand.addEventListener("change", () => {
    gsmArfcn.value = gsmBand.value === "1800" ? 698 : 62;
    saveAndRender();
  });
  gsmArfcn.addEventListener("input", saveAndRender);
  render();
}

fetch("../tools/mdpc-scenario.json")
  .then(response => {
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  })
  .then(setup)
  .catch(() => {
    errors.textContent = "Расчётный сценарий не загрузился. Откройте калькулятор через GitHub Pages или локальный HTTP-сервер.";
  });
