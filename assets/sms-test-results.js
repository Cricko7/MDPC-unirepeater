"use strict";

const smsSection = document.querySelector("#sms-tests");
const smsStatus = document.querySelector("#sms-tests-status");
const smsTable = document.querySelector("#sms-tests-table");
const smsRows = document.querySelector("#sms-tests-rows");
const smsLatencyChange = document.querySelector("#sms-tests-latency-change");
const smsExport = document.querySelector("#sms-tests-export");
const smsModeLabels = new Map([["off", "LTE выключен"], ["on", "LTE включён"]]);
const smsNumber = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const smsCsvNumber = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2, useGrouping: false });
const smsCsvHeaders = [
  "Режим LTE", "Отправлено SMS", "Доставлено SMS", "Доставка, %",
  "Минимальная задержка, мс", "Средняя задержка, мс", "Максимальная задержка, мс",
];

function describeSmsLatencyChange(off, on) {
  if (off == null || on == null) {
    return "Для сравнения средней задержки нужна подтверждённая доставка в обоих режимах LTE.";
  }
  const change = on - off;
  if (smsNumber.format(Math.abs(change)) === "0") {
    return "При включении LTE средняя задержка не изменилась.";
  }
  const direction = change > 0 ? "увеличилась" : "уменьшилась";
  return `При включении LTE средняя задержка ${direction} на ${smsNumber.format(Math.abs(change))} мс.`;
}

function exportSmsTestResults(results) {
  const csv = [smsCsvHeaders, ...results.map(([label, ...values]) =>
    [label, ...values.map(value => value == null ? "" : smsCsvNumber.format(value))])]
    .map(row => row.join(";")).join("\r\n");
  const file = new Blob(["\uFEFF", csv, "\r\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = "datark-sms-test-results.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadSmsTestResults() {
  smsSection.hidden = false;
  try {
    const response = await fetch("/api/sms-test-results", { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("SMS results unavailable");
    const { source, results } = await response.json();
    if (source !== "synthetic" || !Array.isArray(results)) throw new Error("Invalid SMS results");

    const orderedResults = Array.from(smsModeLabels, ([mode, label]) => {
      const result = results.find(row => row.lte_mode === mode);
      const { sent, delivered, latency_ms: latency } = result;
      if (!Number.isInteger(sent) || !Number.isInteger(delivered) || delivered < 0 || delivered > sent ||
          (delivered > 0 && ![latency?.min, latency?.mean, latency?.max].every(Number.isFinite))) {
        throw new Error("Invalid SMS result row");
      }

      const deliveryPercent = sent > 0 ? delivered / sent * 100 : null;
      return { label, sent, delivered, deliveryPercent, latency: delivered > 0 ? latency : null };
    });

    const exportRows = orderedResults.map(({label, sent, delivered, deliveryPercent, latency}) =>
      [label, sent, delivered, deliveryPercent, latency?.min, latency?.mean, latency?.max]);
    const rows = exportRows.map(([label, ...values]) => {
      const row = document.createElement("tr");
      const heading = document.createElement("th");
      heading.scope = "row";
      heading.textContent = label;
      row.append(heading);
      for (const value of values) {
        row.insertCell().textContent = value == null ? "—" : smsNumber.format(value);
      }
      return row;
    });

    smsRows.replaceChildren(...rows);
    smsStatus.textContent = "";
    smsStatus.hidden = true;
    smsTable.hidden = false;
    const [off, on] = orderedResults;
    smsLatencyChange.textContent = describeSmsLatencyChange(off.latency?.mean, on.latency?.mean);
    smsLatencyChange.hidden = false;
    smsExport.addEventListener("click", () => exportSmsTestResults(exportRows));
    smsExport.hidden = false;
  } catch {
    smsStatus.textContent = "Результаты испытаний сейчас недоступны. Обновите страницу, чтобы повторить запрос.";
  }
}

if (document.querySelector('nav a[href="#sms-tests"]')) loadSmsTestResults();
