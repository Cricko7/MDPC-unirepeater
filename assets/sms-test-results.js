"use strict";

const smsSection = document.querySelector("#sms-tests");
const smsStatus = document.querySelector("#sms-tests-status");
const smsTable = document.querySelector("#sms-tests-table");
const smsRows = document.querySelector("#sms-tests-rows");
const smsModeLabels = new Map([["off", "LTE выключен"], ["on", "LTE включён"]]);
const smsNumber = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

async function loadSmsTestResults() {
  smsSection.hidden = false;
  try {
    const response = await fetch("/api/sms-test-results", { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("SMS results unavailable");
    const { source, results } = await response.json();
    if (source !== "synthetic" || !Array.isArray(results)) throw new Error("Invalid SMS results");

    const rows = Array.from(smsModeLabels, ([mode, label]) => {
      const result = results.find(row => row.lte_mode === mode);
      const { sent, delivered, latency_ms: latency } = result;
      if (!Number.isInteger(sent) || !Number.isInteger(delivered) || delivered < 0 || delivered > sent ||
          (delivered > 0 && ![latency?.min, latency?.mean, latency?.max].every(Number.isFinite))) {
        throw new Error("Invalid SMS result row");
      }

      const row = document.createElement("tr");
      const heading = document.createElement("th");
      heading.scope = "row";
      heading.textContent = label;
      row.append(heading);
      for (const value of [sent, delivered, latency?.min, latency?.mean, latency?.max]) {
        row.insertCell().textContent = value == null ? "—" : smsNumber.format(value);
      }
      return row;
    });

    smsRows.replaceChildren(...rows);
    smsStatus.textContent = "";
    smsStatus.hidden = true;
    smsTable.hidden = false;
  } catch {
    smsStatus.textContent = "Результаты испытаний сейчас недоступны. Обновите страницу, чтобы повторить запрос.";
  }
}

if (document.querySelector('nav a[href="#sms-tests"]')) loadSmsTestResults();
