"use strict";

const bands = {
  B1: { min: 2110, max: 2170, widths: [5, 10, 15, 20] },
  B3: { min: 1805, max: 1880, widths: [1.4, 3, 5, 10, 15, 20] },
  B7: { min: 2620, max: 2690, widths: [5, 10, 15, 20] },
};
const blocks = { 1.4: 6, 3: 15, 5: 25, 10: 50, 15: 75, 20: 100 };
const cableLosses = [[1800, 15.6], [2000, 16], [2200, 17.3], [2500, 18.6], [2700, 19.7]];
const format = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "always" });
const carrierRows = document.getElementById("carrier-rows");
const errors = document.getElementById("budget-errors");

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
  return frequencyValid && powerValid ? { frequency, width, power } : null;
}

function rsrp(carrier, zone) {
  const cable = cableLosses.find(([upper]) => carrier.frequency <= upper)[1] * zone.cable_m / 100;
  const freeSpace = 32.44 + 20 * Math.log10(carrier.frequency * zone.distance_m / 1000);
  const feeder = zone.splitter_db + 1.2 + cable;
  const referenceCorrection = 10 * Math.log10(12 * blocks[carrier.width]);
  // As in the Python model, 8 dBi panel gain offsets 8 dB handset loss.
  return carrier.power - feeder - freeSpace - zone.zone_loss_db - referenceCorrection;
}

function setup(scenario) {
  const operators = scenario.operators.map(carrierRow);
  carrierRows.replaceChildren(...operators.map(operator => operator.row));
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

  function render() {
    const problems = [];
    const carriers = operators.map(operator => readCarrier(operator, problems));
    errors.textContent = problems.join(" ");
    let count = 0;
    const resultRows = scenario.zones.map(zone => {
      const row = document.createElement("tr");
      const heading = document.createElement("th");
      heading.scope = "row";
      heading.textContent = zone.id;
      row.append(heading);
      for (const carrier of carriers) {
        const cell = row.insertCell();
        if (!carrier) {
          cell.textContent = "—";
          continue;
        }
        const value = rsrp(carrier, zone);
        const margin = value - target;
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
      summary.textContent = "Общий итог появится после исправления параметров всех несущих.";
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
  form.addEventListener("input", render);
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
