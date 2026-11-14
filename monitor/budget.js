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
const scenariosKey = "mdpc.monitor.budgetScenarios.v1";
const comparisonKey = "mdpc.monitor.budgetComparison.v1";

function loadBudgetSettings(key = settingsKey) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? {};
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
  resetCarrier(fields, operator);
  return { row, fields, name: operator.name, defaults: operator };
}

function resetCarrier(fields, operator) {
  fields.band.value = operator.band;
  fields.frequency.value = operator.dl_mhz ?? "";
  fields.power.value = operator.das_dl_dbm;
  setWidths(fields.width, bands[operator.band], operator.bandwidth_mhz);
}

function centerLimits(band, width) {
  return [band.min + width / 2, band.max - width / 2];
}

function readCarrier({ fields, name }, problems) {
  const band = bands[fields.band.value];
  const width = Number(fields.width.value);
  const [lower, upper] = centerLimits(band, width);
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

function validateImportedSettings(settings, operators) {
  if (settings?.version !== 1 || !settings.carriers || !settings.gsm) {
    throw new Error("Ожидается JSON настроек калькулятора версии 1.");
  }
  if (Object.keys(settings.carriers).length !== operators.length) {
    throw new Error("Файл должен содержать настройки всех пяти операторов.");
  }
  for (const { name } of operators) {
    const carrier = settings.carriers[name];
    if (!Object.hasOwn(settings.carriers, name) || !carrier ||
      typeof carrier.band !== "string" || !Object.hasOwn(bands, carrier.band)) {
      throw new Error(`${name}: отсутствует несущая или указан неподдерживаемый диапазон.`);
    }
    const band = bands[carrier.band];
    if (!band.widths.includes(carrier.width)) {
      throw new Error(`${name}: ширина несущей недопустима для ${carrier.band}.`);
    }
    const [lower, upper] = centerLimits(band, carrier.width);
    const frequency = Number(carrier.frequency);
    if (typeof carrier.frequency !== "string" ||
      (carrier.frequency !== "" && (!isNumberField(carrier.frequency) || frequency < lower || frequency > upper))) {
      throw new Error(`${name}: частота центра должна быть от ${lower} до ${upper} МГц или оставаться пустой.`);
    }
    if (!isNumberField(carrier.power)) {
      throw new Error(`${name}: укажите числовую мощность несущей.`);
    }
  }
  const { band, arfcn } = settings.gsm;
  if ((band !== "900" && band !== "1800") || !isNumberField(arfcn) ||
    !gsmChannel(band, Number(arfcn))) {
    throw new Error("Укажите допустимый диапазон GSM и ARFCN.");
  }
}

function isNumberField(value) {
  return typeof value === "string" && /^-?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(value)
    && Number.isFinite(Number(value));
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

  const report = checkGsm(carriers, band, input.valueAsNumber, channel);
  findings.append(...gsmFindingItems(report.hits));
  result.textContent = gsmSummary(report);
  return report;
}

function checkGsm(carriers, band, arfcn, channel) {
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
  const summary = hits.length
    ? `Пересечений: ${hits.length}.`
    : signals.length ? "Для заданных несущих пересечений не найдено." : "Задайте центры LTE-несущих для проверки.";
  return {
    band: band === "1800" ? "DCS 1800" : "E-GSM 900",
    arfcn, channel, hits, summary,
    checked: signals.length / 2, missing,
  };
}

function gsmSummary({ channel, summary, missing }) {
  return `GSM UL ${format.format(channel.ul)} МГц · DL ${format.format(channel.dl)} МГц. ${summary}`
    + (missing ? ` Вне проверки несущих: ${missing} (центр не задан или параметры некорректны).` : "");
}

function gsmFindingItems(hits) {
  return hits.map(({ type, source, target, low, high }) => {
    const item = document.createElement("li");
    item.textContent = `${type} · ${source} → ${target} (${format.format(low)}–${format.format(high)} МГц)`;
    return item;
  });
}

const gsmCsvHeaders = ["Диапазон GSM", "ARFCN", "GSM UL, МГц", "GSM DL, МГц",
  "Проверено несущих", "Вне проверки", "Итог", "Тип пересечения",
  "Источник LTE или формула IM3", "Направление GSM", "Нижняя граница, МГц", "Верхняя граница, МГц"];

function gsmCsvRows({ band, arfcn, channel, hits, summary, checked, missing }) {
  const mhz = value => value.toFixed(2).replace(".", ",");
  const prefix = [band, arfcn, mhz(channel.ul), mhz(channel.dl), checked, missing, summary];
  const rows = hits.map(({ type, source, target, low, high }) =>
    [...prefix, type, source, target, mhz(low), mhz(high)]);
  if (!rows.length) rows.push([...prefix, "", "", "", "", ""]);
  return rows;
}

function downloadGsm(report) {
  downloadCsv("mdpc-gsm-check.csv", gsmCsvHeaders, gsmCsvRows(report));
}

function downloadComparison({ headings, coverage, reports, target }) {
  const scenarioLabels = headings.map(heading => /^[=+\-@＝＋－＠\t\r\n]/u.test(heading) ? `'${heading}` : heading);
  const lteHeaders = ["Диапазон LTE", "Частота DL для расчёта, МГц", "Режим частоты",
    "Ширина несущей, МГц", "Мощность на входе DAS, дБм", "RSRP, дБм", "Запас до порога, дБ"];
  const coverageHeaders = ["Оператор", "Зона", "Порог RSRP, дБм",
    ...["A", "B"].flatMap(side => lteHeaders.map(header => `${side} · ${header}`)),
    "Δ RSRP B − A, дБ", "Δ запаса B − A, дБ"];
  const emptyGsm = Array(gsmCsvHeaders.length).fill("");
  const emptyCoverage = Array(coverageHeaders.length).fill("");
  const decimal = value => value.toFixed(2).replace(".", ",");
  const rows = coverage.map(({ name, zone, carriers, values, delta }) => [
    "Покрытие", ...scenarioLabels, "", name, zone, target,
    ...carriers.flatMap(({ band, frequency, useEdge, width, power }, index) => [
      band, frequency, useEdge ? "Верхняя граница" : "Центр несущей", width, power,
      decimal(values[index]), decimal(values[index] - target),
    ]),
    decimal(delta), decimal(delta), ...emptyGsm,
  ]);
  for (const [index, report] of reports.entries()) {
    for (const row of gsmCsvRows(report)) {
      rows.push(["GSM", ...scenarioLabels, index === 0 ? "A" : "B", ...emptyCoverage, ...row]);
    }
  }
  downloadCsv("mdpc-scenario-comparison.csv",
    ["Тип строки", "Сценарий A", "Сценарий B", "Сторона GSM", ...coverageHeaders, ...gsmCsvHeaders], rows);
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
  downloadFile(filename, new Blob(["\uFEFF", csv, "\r\n"], { type: "text/csv;charset=utf-8" }));
}

function downloadFile(filename, file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readScenarios() {
  const saved = JSON.parse(localStorage.getItem(scenariosKey));
  return Array.isArray(saved) ? saved.filter(entry =>
    typeof entry?.name === "string" && entry.name.trim() && entry.name.length <= 60) : [];
}

function comparisonTable(id, caption, columns, rows) {
  const table = document.getElementById(id);
  table.replaceChildren();
  table.createCaption().textContent = caption;
  const header = table.createTHead().insertRow();
  for (const title of columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = title;
    header.append(cell);
  }
  const body = table.createTBody();
  for (const [label, ...values] of rows) {
    const row = body.insertRow();
    const cell = document.createElement("th");
    cell.scope = "row";
    cell.textContent = label;
    row.append(cell);
    for (const value of values) row.insertCell().textContent = value;
  }
}

function scenarioComparison(operators, scenario) {
  const selects = ["compare-a", "compare-b"].map(id => document.getElementById(id));
  const status = document.getElementById("compare-status");
  const results = document.getElementById("compare-results");
  const exportButton = document.getElementById("compare-export");
  const swapButton = document.getElementById("compare-swap");
  const clearButton = document.getElementById("compare-clear");
  const differences = document.getElementById("compare-differences");
  const gsmSection = document.getElementById("compare-gsm-section");
  let comparison = null;
  let entries = [];
  const saved = loadBudgetSettings(comparisonKey);
  let selection = [saved.a, saved.b];

  function saveSelection() {
    const [a, b] = selects.map(select => select.value);
    if (a === selection[0] && b === selection[1]) return;
    selection = [a, b];
    try {
      localStorage.setItem(comparisonKey, JSON.stringify({ a, b }));
    } catch {
      // Comparison still works when browser storage is unavailable.
    }
  }

  function render() {
    results.hidden = true;
    comparison = null;
    exportButton.disabled = true;
    swapButton.disabled = true;
    differences.disabled = true;
    clearButton.disabled = !selects.some(select => select.value);
    if (entries.length < 2) {
      status.textContent = "Сохраните два сценария для сравнения.";
      return;
    }
    if (!selects.every(select => select.value) || selects[0].value === selects[1].value) {
      status.textContent = "Выберите два разных сценария.";
      return;
    }
    swapButton.disabled = false;
    const pair = selects.map(select => entries.find(entry => entry.name === select.value));
    let carriers;
    try {
      carriers = pair.map(({ settings }) => {
        validateImportedSettings(settings, operators);
        return operators.map(({ name }) => {
          const { band, width, frequency, power } = settings.carriers[name];
          return { name, band, width, frequency: frequency === "" ? bands[band].max : Number(frequency),
            power: Number(power), useEdge: frequency === "" };
        });
      });
    } catch (error) {
      status.textContent = `Сравнение недоступно. ${error.message}`;
      return;
    }
    differences.disabled = false;
    const changedOperators = new Set(operators.filter((_, index) => {
      const [a, b] = carriers.map(side => side[index]);
      return a.band !== b.band || a.frequency !== b.frequency || a.width !== b.width ||
        a.power !== b.power || a.useEdge !== b.useEdge;
    }).map(({ name }) => name));
    const headings = pair.map(({ name }, index) => `${index === 0 ? "A" : "B"} · ${name}`);
    const carrierText = ({ band, width, frequency, power, useEdge }) =>
      `${band} · ${format.format(frequency)} МГц${useEdge ? " (край диапазона)" : ""} · ${width} МГц · ${signed.format(power)} дБм`;
    const carrierRows = operators.map(({ name }, index) =>
      [name, ...carriers.map(side => carrierText(side[index]))]);
    comparisonTable("compare-carriers", "Параметры LTE · частота DL, ширина, мощность на входе DAS",
      ["Оператор", ...headings], differences.checked
        ? carrierRows.filter(([name]) => changedOperators.has(name)) : carrierRows);

    const target = scenario.rsrp_target_dbm;
    const coverageText = value => `${format.format(value)} дБм · запас ${signed.format(value - target)} дБ`;
    const allCoverage = operators.flatMap(({ name }, index) => scenario.zones.map(zone => {
      const zoneCarriers = carriers.map(side => side[index]);
      const values = zoneCarriers.map(carrier => rsrp(carrier, zone));
      return { name, zone: zone.id, carriers: zoneCarriers, values, delta: values[1] - values[0] };
    }));
    const coverage = differences.checked
      ? allCoverage.filter(row => changedOperators.has(row.name) || row.delta !== 0)
      : allCoverage;
    status.textContent = differences.checked
      ? (coverage.length ? `Различия в ${coverage.length} из ${allCoverage.length} строк покрытия. Разница B − A.`
        : "Различий в параметрах LTE, RSRP и запасе нет.")
      : "Разница рассчитана как B − A по сохранённым параметрам.";
    comparisonTable("compare-coverage", "RSRP и запас по зонам",
      ["Оператор · зона", ...headings, "Δ RSRP / Δ запаса, дБ"],
      coverage.map(({ name, zone, values, delta }) => {
        const difference = signed.format(delta);
        return [`${name} · ${zone}`, ...values.map(coverageText), `${difference} / ${difference}`];
      }));

    gsmSection.hidden = differences.checked;
    const reports = differences.checked ? [] : pair.map(({ settings }, index) => {
      const { band, arfcn } = settings.gsm;
      const number = Number(arfcn);
      return checkGsm(carriers[index], band, number, gsmChannel(band, number));
    });
    document.getElementById("compare-gsm").replaceChildren(...reports.map((report, index) => {
      const card = document.createElement("article");
      const heading = document.createElement("h3");
      heading.textContent = `GSM · ${headings[index]}`;
      const summary = document.createElement("p");
      summary.textContent = `${report.band} · ARFCN ${report.arfcn}. ${gsmSummary(report)}`;
      card.append(heading, summary);
      if (report.hits.length) {
        const list = document.createElement("ul");
        list.append(...gsmFindingItems(report.hits));
        card.append(list);
      }
      return card;
    }));
    comparison = { headings: pair.map(({ name }) => name), coverage, reports, target };
    exportButton.disabled = coverage.length === 0;
    results.hidden = coverage.length === 0;
  }

  exportButton.addEventListener("click", () => {
    if (comparison) downloadComparison(comparison);
  });
  function updateSelection() {
    saveSelection();
    render();
  }

  for (const select of selects) select.addEventListener("change", updateSelection);
  differences.addEventListener("change", render);
  swapButton.addEventListener("click", () => {
    const [a, b] = selects.map(select => select.value);
    selects[0].value = b;
    selects[1].value = a;
    updateSelection();
  });
  clearButton.addEventListener("click", () => {
    for (const select of selects) select.value = "";
    updateSelection();
  });
  return (updated, renamed = {}) => {
    entries = updated;
    for (const [index, select] of selects.entries()) {
      const name = selection[index];
      const previous = typeof name === "string" && Object.hasOwn(renamed, name) ? renamed[name] : name;
      select.replaceChildren(new Option("Выберите сценарий", ""),
        ...entries.map(({ name }) => new Option(name, name)));
      if (entries.some(entry => entry.name === previous)) select.value = previous;
      select.disabled = entries.length < 2;
    }
    updateSelection();
  };
}

function setupNamedScenarios(operators, currentSettings, applySettings, saveAndRender, updateComparison) {
  const form = document.getElementById("budget-scenario-form");
  const nameInput = document.getElementById("budget-scenario-name");
  const list = document.getElementById("budget-scenario-list");
  const saveButton = document.getElementById("budget-scenario-save");
  const loadButton = document.getElementById("budget-scenario-load");
  const copyButton = document.getElementById("budget-scenario-copy");
  const renameButton = document.getElementById("budget-scenario-rename");
  const deleteButton = document.getElementById("budget-scenario-delete");
  const status = document.getElementById("budget-scenario-status");
  let scenarios = [];

  function updateList(selected = "") {
    list.replaceChildren(new Option(scenarios.length ? "Выберите сценарий" : "Сценариев пока нет", ""),
      ...scenarios.map(({ name }) => new Option(name, name)));
    list.value = selected;
    list.disabled = scenarios.length === 0;
    updateActions();
  }

  function updateActions() {
    for (const button of [loadButton, copyButton, renameButton, deleteButton]) button.disabled = !list.value;
  }

  function writeScenarios(updated, selected, renamed) {
    localStorage.setItem(scenariosKey, JSON.stringify(updated));
    scenarios = updated;
    updateList(selected);
    updateComparison(scenarios, renamed);
  }

  function requestName(message, defaultName) {
    const response = window.prompt(message, defaultName);
    if (response === null) return null;
    const name = response.trim();
    if (name && name.length <= nameInput.maxLength) return name;
    status.textContent = `Введите имя длиной от 1 до ${nameInput.maxLength} символов.`;
    return null;
  }

  try {
    scenarios = readScenarios();
  } catch {
    status.textContent = "Сохранённые сценарии не удалось прочитать.";
  }
  updateList();
  updateComparison(scenarios);
  saveButton.disabled = false;

  list.addEventListener("change", updateActions);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      status.textContent = "Введите имя сценария.";
      return;
    }
    const settings = currentSettings();
    try {
      validateImportedSettings(settings, operators);
    } catch (error) {
      status.textContent = `Сценарий не сохранён. ${error.message}`;
      return;
    }
    try {
      const updated = readScenarios().filter(entry => entry.name !== name);
      updated.push({ name, settings });
      writeScenarios(updated, name);
      status.textContent = `Сценарий «${name}» сохранён.`;
    } catch {
      status.textContent = "Сценарий не удалось сохранить в хранилище браузера.";
    }
  });
  loadButton.addEventListener("click", () => {
    const entry = scenarios.find(scenario => scenario.name === list.value);
    if (!entry) return;
    try {
      validateImportedSettings(entry.settings, operators);
      applySettings(entry.settings);
      nameInput.value = entry.name;
      const saved = saveAndRender();
      status.textContent = saved ? `Сценарий «${entry.name}» загружен.`
        : `Сценарий «${entry.name}» загружен. Текущие настройки не удалось сохранить.`;
    } catch (error) {
      status.textContent = `Сценарий не загружен. ${error.message}`;
    }
  });
  copyButton.addEventListener("click", () => {
    const sourceName = list.value;
    const name = requestName("Имя копии сценария", `${sourceName.slice(0, nameInput.maxLength - 8)} (копия)`);
    if (name === null) return;
    try {
      const latest = readScenarios();
      const source = latest.find(entry => entry.name === sourceName);
      if (!source) {
        scenarios = latest;
        updateList();
        updateComparison(scenarios);
        status.textContent = "Выбранный сценарий отсутствует в хранилище.";
        return;
      }
      if (latest.some(entry => entry.name === name)) {
        status.textContent = `Имя «${name}» уже используется.`;
        return;
      }
      validateImportedSettings(source.settings, operators);
      writeScenarios([...latest, { name, settings: source.settings }], name);
      applySettings(source.settings);
      nameInput.value = name;
      const saved = saveAndRender();
      status.textContent = saved ? `Копия «${name}» сохранена и загружена.`
        : `Копия «${name}» сохранена. Текущие настройки не удалось сохранить.`;
    } catch (error) {
      status.textContent = `Сценарий не скопирован. ${error.message}`;
    }
  });
  renameButton.addEventListener("click", () => {
    const previousName = list.value;
    const name = requestName("Новое имя сценария", previousName);
    if (name === null || name === previousName) return;
    try {
      const latest = readScenarios();
      if (!latest.some(entry => entry.name === previousName)) {
        scenarios = latest;
        updateList();
        updateComparison(scenarios);
        status.textContent = "Выбранный сценарий отсутствует в хранилище.";
        return;
      }
      if (latest.some(entry => entry.name === name)) {
        status.textContent = `Имя «${name}» уже используется.`;
        return;
      }
      writeScenarios(latest.map(entry => entry.name === previousName ? { ...entry, name } : entry),
        name, { [previousName]: name });
      if (nameInput.value.trim() === previousName) nameInput.value = name;
      status.textContent = `Сценарий переименован в «${name}».`;
    } catch {
      status.textContent = "Сценарий не удалось переименовать в хранилище браузера.";
    }
  });
  deleteButton.addEventListener("click", () => {
    const name = list.value;
    if (!window.confirm(`Удалить сохранённый сценарий «${name}»?`)) return;
    try {
      writeScenarios(readScenarios().filter(entry => entry.name !== name), "");
      if (nameInput.value.trim() === name) nameInput.value = "";
      status.textContent = `Сценарий «${name}» удалён.`;
    } catch {
      status.textContent = "Сценарий не удалось удалить из хранилища браузера.";
    }
  });
}

function setup(scenario) {
  const operators = scenario.operators.map(carrierRow);
  carrierRows.replaceChildren(...operators.map(operator => operator.row));
  const gsmBand = document.getElementById("gsm-band");
  const gsmArfcn = document.getElementById("gsm-arfcn");
  function applySettings(saved) {
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
  }
  applySettings(loadBudgetSettings());

  function currentSettings() {
    const carriers = Object.fromEntries(operators.map(({ fields, name }) => [name, {
      band: fields.band.value,
      width: Number(fields.width.value),
      frequency: fields.frequency.value,
      power: fields.power.value,
    }]));
    return { version: 1, carriers, gsm: { band: gsmBand.value, arfcn: gsmArfcn.value } };
  }

  function saveAndRender() {
    let saved = true;
    try {
      localStorage.setItem(settingsKey, JSON.stringify(currentSettings()));
    } catch {
      saved = false;
    }
    render();
    return saved;
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
  const settingsExport = document.getElementById("budget-settings-export");
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
    settingsExport.disabled = exportButton.disabled || gsmExport.disabled;
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
  const resetButton = document.getElementById("budget-reset");
  const importButton = document.getElementById("budget-import");
  const settingsFile = document.getElementById("budget-settings-file");
  const settingsStatus = document.getElementById("budget-settings-status");
  importButton.addEventListener("click", () => settingsFile.click());
  settingsExport.addEventListener("click", () => {
    downloadFile("mdpc-calculator-settings.json", new Blob(
      [JSON.stringify(currentSettings(), null, 2), "\n"], { type: "application/json" }));
  });
  settingsFile.addEventListener("change", async () => {
    const file = settingsFile.files[0];
    settingsFile.value = "";
    if (!file) return;
    importButton.disabled = true;
    try {
      const settings = JSON.parse(await file.text());
      validateImportedSettings(settings, operators);
      applySettings(settings);
      const saved = saveAndRender();
      settingsStatus.textContent = saved ? "Настройки импортированы и сохранены."
        : "Настройки импортированы. Хранилище браузера недоступно.";
    } catch (error) {
      const reason = error instanceof SyntaxError ? "Файл содержит некорректный JSON." : error.message;
      settingsStatus.textContent = `Импорт не выполнен. ${reason}`;
    } finally {
      importButton.disabled = false;
    }
  });
  resetButton.addEventListener("click", () => {
    for (const { fields, defaults } of operators) resetCarrier(fields, defaults);
    gsmBand.selectedIndex = 0;
    gsmArfcn.value = gsmArfcn.defaultValue;
    settingsStatus.textContent = "";
    saveAndRender();
  });
  render();
  setupNamedScenarios(operators, currentSettings, applySettings, saveAndRender, scenarioComparison(operators, scenario));
  resetButton.disabled = false;
  importButton.disabled = false;
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
