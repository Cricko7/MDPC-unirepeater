"use strict";

{
  const { zones, statusLabels, alarmTypes, formatValue } = monitoringTelemetry;
  const form = document.querySelector("#zone-telemetry");
  const zone = form.querySelector("#telemetry-zone");
  const fields = form.querySelector("#telemetry-fields");
  const status = form.querySelector("#telemetry-status");
  const rsrp = form.querySelector("#telemetry-rsrp");
  const sinr = form.querySelector("#telemetry-sinr");
  const alarmInputs = [...form.querySelectorAll('[name="telemetry-alarm"]')];
  const current = form.querySelector("#telemetry-current");
  const result = form.querySelector("#telemetry-result");
  const reset = form.querySelector("#telemetry-reset");
  const resetAll = form.querySelector("#telemetry-reset-all");
  const reload = form.querySelector("#telemetry-reload");

  zone.replaceChildren(...zones.map(({ id, name }) => new Option(id + " · " + name, id)));
  status.replaceChildren(...Object.entries(statusLabels).map(([value, label]) => new Option(label, value)));

  async function loadZone() {
    fields.disabled = true;
    current.textContent = "";
    const response = await fetch("../api/telemetry", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Не удалось загрузить текущие показания.");
    const snapshot = await response.json();
    const reading = snapshot.zones.find(item => item.id === zone.value);
    const alarms = snapshot.alarms.filter(alarm => alarm.sourceId === zone.value).map(alarm => alarm.type);
    status.value = reading.status;
    rsrp.value = reading.reading?.rsrp ?? "";
    sinr.value = reading.reading?.sinr ?? "";
    for (const input of alarmInputs) input.checked = alarms.includes(input.value);
    const signal = reading.reading
      ? `RSRP ${formatValue(reading.reading.rsrp)} дБм · SINR ${formatValue(reading.reading.sinr)} дБ`
      : "Показаний нет";
    const alarmLabels = alarms.map(type => alarmTypes[type].title).join(", ") || "Активных тревог нет";
    current.textContent = `${reading.manual ? "Ручные данные" : "Симуляция"} · ${statusLabels[reading.status]} · ${signal} · ${alarmLabels}`;
    reset.disabled = !reading.manual;
    resetAll.disabled = !snapshot.zones.some(item => item.manual);
    fields.disabled = false;
  }

  async function update(override, target = zone.value) {
    const canResetAll = !resetAll.disabled;
    resetAll.disabled = true;
    zone.disabled = reload.disabled = fields.disabled = true;
    result.textContent = override === undefined ? "Загрузка телеметрии…" : "Сохранение…";
    try {
      let message = "";
      if (override !== undefined) {
        const response = await fetch("telemetry", {
          method: "PUT", headers: { "Content-Type": "application/json", "X-Datark-Admin": "telemetry" },
          body: JSON.stringify({ zone: target, override }), signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Не удалось сохранить телеметрию.");
        }
        message = target === "all" ? "Все зоны возвращены к симуляции."
          : override === null ? "Зона возвращена к симуляции." : "Телеметрия сохранена.";
        showToast(message);
      }
      result.textContent = message;
      try {
        await loadZone();
      } catch {
        result.textContent = [message, "Не удалось загрузить показания. Нажмите «Обновить показания»."].filter(Boolean).join(" ");
      }
    } catch (error) {
      result.textContent = error.message;
      fields.disabled = false;
      resetAll.disabled = !canResetAll;
      showToast(error.message, "error");
    } finally {
      zone.disabled = reload.disabled = false;
    }
  }

  zone.addEventListener("change", () => update());
  reload.addEventListener("click", () => update());
  reset.addEventListener("click", () => update(null));
  resetAll.addEventListener("click", () => {
    if (window.confirm("Вернуть все зоны к симуляции? Ручные значения всех зон будут сброшены.")) {
      update(null, "all");
    }
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if ((rsrp.value === "") !== (sinr.value === "")) {
      result.textContent = "Заполните оба числовых поля или оставьте оба пустыми.";
      return;
    }
    update({
      status: status.value,
      reading: rsrp.value === "" ? null : { rsrp: rsrp.valueAsNumber, sinr: sinr.valueAsNumber },
      alarms: alarmInputs.filter(input => input.checked).map(input => input.value),
    });
  });
  update();
}
