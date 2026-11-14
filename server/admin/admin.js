"use strict";

const widths = { B1: [5, 10, 15, 20], B3: [1.4, 3, 5, 10, 15, 20], B7: [5, 10, 15, 20] };
const form = document.querySelector("#settings");
const operatorRows = document.querySelector("#operators");
const scenario = document.querySelector("#scenario");
const gsmBand = document.querySelector("#gsm-band");
const arfcn = document.querySelector("#gsm-arfcn");
const result = document.querySelector("#result");
const save = document.querySelector("#save");

function makeRow(operator) {
  const row = document.createElement("tr");
  row.innerHTML = '<th scope="row"></th><td><select></select></td><td><input type="number" step="any"></td><td><select></select></td><td><input type="number" step="any" required></td>';
  row.querySelector("th").textContent = operator.name;
  const [band, center, width, power] = row.querySelectorAll("select, input");
  [band, center, width, power].forEach((field, index) => {
    field.setAttribute("aria-label", operator.name + " · " + ["Диапазон", "Частота DL", "Ширина", "Мощность"][index]);
  });
  band.replaceChildren(...Object.keys(widths).map(value => new Option(value)));
  band.value = operator.band;
  const setWidths = value => {
    width.replaceChildren(...widths[band.value].map(item => new Option(String(item))));
    width.value = widths[band.value].includes(Number(value)) ? value : 10;
  };
  setWidths(operator.bandwidth_mhz);
  band.addEventListener("change", () => setWidths(width.value));
  center.value = operator.dl_mhz ?? "";
  power.value = operator.das_dl_dbm;
  return row;
}

async function request(options) {
  const response = await fetch("settings", options);
  const settings = await response.json();
  if (!response.ok) throw new Error(settings.error);
  return settings;
}

request().then(settings => {
  scenario.value = settings.scenario;
  gsmBand.value = settings.calculator.gsm.band;
  arfcn.value = settings.calculator.gsm.arfcn;
  operatorRows.replaceChildren(...settings.calculator.operators.map(makeRow));
  form.querySelectorAll("fieldset").forEach(field => { field.disabled = false; });
  save.disabled = false;
  result.textContent = "";
}).catch(error => { result.textContent = error.message; });

gsmBand.addEventListener("change", () => {
  arfcn.value = gsmBand.value === "900" ? 62 : 698;
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  save.disabled = true;
  result.textContent = "Сохранение…";
  const operators = Array.from(operatorRows.rows, row => {
    const [band, center, width, power] = row.querySelectorAll("select, input");
    return {
      name: row.querySelector("th").textContent,
      band: band.value, dl_mhz: center.value === "" ? null : center.valueAsNumber,
      bandwidth_mhz: Number(width.value), das_dl_dbm: power.valueAsNumber,
    };
  });
  try {
    await request({
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Datark-Admin": "settings" },
      body: JSON.stringify({ scenario: scenario.value, calculator: {
        operators, gsm: { band: gsmBand.value, arfcn: arfcn.valueAsNumber },
      } }),
    });
    result.textContent = "Стартовые настройки сохранены.";
  } catch (error) {
    result.textContent = error.message;
  } finally {
    save.disabled = false;
  }
});
