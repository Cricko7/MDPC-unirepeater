"use strict";

const monitoringTelemetry = (() => {
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
  function alarmDetails(sourceId, type) {
    return { sourceId, type, source: alarmSources.get(sourceId), ...alarmTypes[type] };
  }

  function sampleZone(zone, index, scenario) {
    if (scenario === "offline" || (scenario === "mixed" && zone.id === "A5" && index >= 3)) {
      return null;
    }
    const drift = variation[(index + Number(zone.id.slice(1))) % variation.length];
    if (scenario === "mixed" && zone.id === "A2" && index >= 3) {
      return { rsrp: -105 + drift, sinr: 2 + drift };
    }
    return { rsrp: zone.rsrp + drift, sinr: zone.sinr + drift };
  }

  function makeSample(index, time, scenario, lastSeen) {
    const readings = zones.map(zone => {
      const reading = sampleZone(zone, index, scenario);
      if (reading) lastSeen.set(zone.id, time);
      return [zone.id, reading];
    });
    return { time, zones: Object.fromEntries(readings) };
  }

  function belowThreshold(reading) {
    return reading && Object.keys(metrics).some(metric => reading[metric] < metrics[metric].threshold);
  }

  function zoneStatus(zone, samples) {
    const current = samples.at(-1).zones[zone.id];
    if (!current) return "critical";
    return samples.slice(-3).every(sample => belowThreshold(sample.zones[zone.id]))
      ? "warning" : "good";
  }

  function formatValue(value) {
    return value == null ? "—" : String(value).replace("-", "−");
  }

  function getAlarms(states, scenario, samples, lastSeen) {
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

  function seedSamples(scenario, now) {
    const lastSeen = new Map(zones.map(zone => [zone.id, now - sampleCount * interval]));
    const samples = Array.from({ length: sampleCount }, (_, index) =>
      makeSample(index, now - (sampleCount - 1 - index) * interval, scenario, lastSeen));
    return { samples, lastSeen };
  }

  function createSnapshot(scenario, samples, lastSeen) {
    const states = zones.map(zone => ({ zone, status: zoneStatus(zone, samples) }));
    const alarms = getAlarms(states, scenario, samples, lastSeen);
    const latest = samples.at(-1);
    return {
      time: latest.time,
      online: scenario !== "offline",
      zones: states.map(({ zone, status }) => ({ id: zone.id, status, reading: latest.zones[zone.id] })),
      alarms: alarms.map(({ sourceId, type }) => ({ sourceId, type })),
    };
  }

  const snapshotKey = "mdpc.monitor.snapshot.v1";

  function readSnapshot() {
    let scenario = "mixed";
    try {
      const saved = JSON.parse(localStorage.getItem(snapshotKey));
      if ((Number.isFinite(saved?.time) && Math.abs(saved.time) <= 8.64e15) && typeof saved.online === "boolean" &&
          Array.isArray(saved.zones) && saved.zones.every(zone => zone && Object.hasOwn(statusLabels, zone.status)) &&
          Array.isArray(saved.alarms) && saved.alarms.every(alarm => alarm && Object.hasOwn(alarmTypes, alarm.type))) return saved;
      const priorScenario = JSON.parse(localStorage.getItem("mdpc.monitor.alarmHistory.v1"))?.scenario;
      if (["normal", "offline"].includes(priorScenario)) scenario = priorScenario;
    } catch {
      // The demo works when storage is empty or unavailable.
    }
    const { samples, lastSeen } = seedSamples(scenario, Date.now());
    return { ...createSnapshot(scenario, samples, lastSeen), time: null };
  }

  return {
    interval, sampleCount, metrics, zones, variation, statusLabels, severityLabels, alarmTypes,
    alarmSources, alarmDetails, formatValue, makeSample, seedSamples, createSnapshot, snapshotKey, readSnapshot,
  };
})();
