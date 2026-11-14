const points = {
  R1: {
    type: "Репитер",
    title: "LTE-репитер",
    description: "В технологическом тамбуре. Принимает сигнал от наружной антенны и распределяет его по пяти внутренним антеннам.",
  },
  A1: {
    title: "Верхний проход",
    description: "Антенна в левом торце аппаратного зала между перегородкой и рядом ТШ1. Направлена вправо вдоль прохода.",
  },
  A2: {
    title: "Центральный проход",
    description: "Антенна у правого торца между рядами ТШ1 и ТШ2, рядом с дверью Д4. Направлена в сторону Д5.",
  },
  A3: {
    title: "Нижний проход",
    description: "Антенна в правом торце прохода между рядом ТШ2 и стеной А. Направлена влево и подключена напрямую к делителю S1.",
  },
  A4: {
    title: "Энергомодуль",
    description: "Антенна в правом торце энергомодуля, вне зоны открывания двери Д3. Контрольные точки находятся у ВРУ и перед щитами.",
  },
  A5: {
    title: "Технологический тамбур",
    description: "Антенна у правого верхнего угла тамбура. Направлена по диагонали к проходу между дверями.",
  },
};

const {
  statusLabels, severityLabels, alarmDetails, alarmTypes, formatValue, metrics,
  snapshotKey, scenarioKey, readScenario, chooseScenario, readSnapshot, setDefaultScenario,
  selectedZoneKey, readSelectedZone, saveSelectedZone,
} = monitoringTelemetry;
const linkParams = new URLSearchParams(location.search);
const linkedPoint = linkParams.get("zone");
const linkedScenario = linkParams.get("scenario");
const scenarioSelect = document.querySelector("#landing-scenario");
const copyLink = document.querySelector("#copy-layout-link");
const shareStatus = document.querySelector("#layout-share-status");
const shareUrl = document.querySelector("#layout-share-url");
const pointButtons = document.querySelectorAll("[data-point]");
const pointType = document.querySelector("#point-type");
const pointTitle = document.querySelector("#point-title");
const pointDescription = document.querySelector("#point-description");
const drawing = document.querySelector(".drawing-scroll");
const map = document.querySelector("#landing-map");
const zoomOut = document.querySelector("#zoom-out");
const zoomIn = document.querySelector("#zoom-in");
const zoomValue = document.querySelector("#zoom-value");
const pointStatus = document.querySelector("#point-status");
const pointMetrics = document.querySelector("#point-metrics");
const metricValues = {
  rsrp: document.querySelector("#point-rsrp"),
  sinr: document.querySelector("#point-sinr"),
};
const pointAlarms = document.querySelector("#point-alarms");
const noAlarms = document.querySelector("#point-no-alarms");
const dataCaption = document.querySelector("#point-data-caption");
const timeFormat = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const zoomLevels = [100, 125, 150, 200];
let zoomIndex = 0;
let selectedPoint = readSelectedZone();
let sharedZone = selectedPoint;
let snapshot;

function layoutUrl() {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set("zone", selectedPoint);
  url.searchParams.set("scenario", snapshot.scenario);
  url.hash = "layout";
  return url;
}

function updateShareLink() {
  if (linkParams.has("zone") || linkParams.has("scenario")) {
    history.replaceState(history.state, "", layoutUrl());
  }
  shareStatus.textContent = "";
  shareUrl.hidden = true;
}

copyLink.addEventListener("click", async () => {
  if (!snapshot) return;
  const url = layoutUrl().href;
  try {
    await navigator.clipboard.writeText(url);
    shareStatus.textContent = "Ссылка скопирована.";
    showToast(shareStatus.textContent);
    shareUrl.hidden = true;
  } catch {
    shareStatus.textContent = "Скопируйте выделенную ссылку вручную.";
    showToast(shareStatus.textContent, "error");
    shareUrl.value = url;
    shareUrl.hidden = false;
    shareUrl.focus();
    shareUrl.select();
  }
});

function showPointTelemetry() {
  const repeater = selectedPoint === "R1";
  const zone = snapshot.zones.find(zone => zone.id === selectedPoint);
  const status = repeater ? (snapshot.online ? "good" : "critical") : zone?.status;
  pointStatus.className = "status " + (status || "");
  pointStatus.lastElementChild.textContent = repeater
    ? (snapshot.online ? "В работе" : "Отключён")
    : (statusLabels[status] || "Нет данных");
  pointMetrics.hidden = repeater;
  for (const [metric, element] of Object.entries(metricValues)) {
    const value = zone?.reading?.[metric];
    element.textContent = Number.isFinite(value) ? formatValue(value) + " " + metrics[metric].unit : "—";
  }

  const alarms = snapshot.alarms.filter(alarm => alarm.sourceId === selectedPoint && Object.hasOwn(alarmTypes, alarm.type));
  pointAlarms.replaceChildren(...alarms.map(({ sourceId, type }) => {
    const { title, detail, level } = alarmDetails(sourceId, type);
    const item = document.createElement("li");
    const label = document.createElement("strong");
    label.className = level;
    label.textContent = severityLabels[level] + " · " + title;
    const description = document.createElement("p");
    description.textContent = detail;
    item.append(label, description);
    return item;
  }));
  pointAlarms.hidden = alarms.length === 0;
  noAlarms.hidden = alarms.length > 0;
}

function syncMonitoring(choice = readScenario()) {
  snapshot = readSnapshot(choice);
  scenarioSelect.value = choice.followsDefault ? "server" : snapshot.scenario;
  for (const marker of map.querySelectorAll("[data-point]")) {
    const id = marker.dataset.point;
    const repeater = id === "R1";
    const status = repeater ? (snapshot.online ? "good" : "critical")
      : snapshot.zones.find(zone => zone.id === id)?.status;
    const label = repeater ? (snapshot.online ? "В работе" : "Отключён") : (statusLabels[status] || "Нет данных");
    marker.dataset.status = status || "critical";
    marker.title = id + " · " + points[id].title + " · " + label;
    marker.setAttribute("aria-label", marker.title);
  }
  dataCaption.textContent = snapshot.time === null
    ? "Тестовые данные"
    : "Тестовые данные · " + timeFormat.format(snapshot.time);
  showPointTelemetry();
}


function centerOnPoint(marker) {
  const viewport = drawing.getBoundingClientRect();
  const point = marker.getBoundingClientRect();
  drawing.scrollBy({
    left: point.left + (point.width - viewport.width) / 2 - viewport.left,
    top: point.top + (point.height - viewport.height) / 2 - viewport.top,
  });
}

function showPoint(id) {
  selectedPoint = id;
  const { type = "Антенна", title, description } = points[id];
  pointType.textContent = id + " · " + type;
  pointTitle.textContent = title;
  pointDescription.textContent = description;
  for (const control of pointButtons) {
    control.setAttribute("aria-pressed", String(control.dataset.point === id));
  }
  if (snapshot) showPointTelemetry();
  centerOnPoint(map.querySelector('[data-point="' + id + '"]'));
}

function syncSelectedZone() {
  const id = readSelectedZone();
  if (sharedZone === id) return;
  sharedZone = id;
  showPoint(id);
  updateShareLink();
}

for (const button of pointButtons) {
  button.addEventListener("click", () => {
    const id = button.dataset.point;
    if (id !== "R1") {
      sharedZone = id;
      saveSelectedZone(id);
    }
    showPoint(id);
    updateShareLink();
  });
}

function changeZoom(step) {
  zoomIndex += step;
  const zoom = zoomLevels[zoomIndex] + "%";
  map.style.setProperty("--drawing-width", zoom);
  zoomValue.value = zoom;
  zoomOut.disabled = zoomIndex === 0;
  zoomIn.disabled = zoomIndex === zoomLevels.length - 1;
  centerOnPoint(map.querySelector('[aria-pressed="true"]'));
}

zoomOut.addEventListener("click", () => changeZoom(-1));
zoomIn.addEventListener("click", () => changeZoom(1));

function refreshMonitoring() {
  if (!snapshot) return;
  const previousScenario = snapshot.scenario;
  syncMonitoring();
  if (snapshot.scenario !== previousScenario) updateShareLink();
}

scenarioSelect.addEventListener("change", () => {
  syncMonitoring(chooseScenario(scenarioSelect.value));
  updateShareLink();
  showToast("Тестовый сценарий изменён.");
});
window.addEventListener("storage", event => {
  if (event.key === scenarioKey || event.key === snapshotKey || event.key === null) refreshMonitoring();
  if (event.key === selectedZoneKey || event.key === null) syncSelectedZone();
});
window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  refreshMonitoring();
  syncSelectedZone();
});

siteDefaults.then(defaults => {
  setDefaultScenario(defaults.scenario);
  const sharedScenario = ["mixed", "normal", "offline"].includes(linkedScenario)
    ? chooseScenario(linkedScenario) : undefined;
  if (Object.hasOwn(points, linkedPoint)) {
    selectedPoint = linkedPoint;
    if (selectedPoint !== "R1") {
      sharedZone = selectedPoint;
      saveSelectedZone(sharedZone);
    }
  }
  syncMonitoring(sharedScenario);
  showPoint(selectedPoint);
  scenarioSelect.disabled = false;
  watchSiteDefaults(defaults, settings => {
    setDefaultScenario(settings.scenario);
    refreshMonitoring();
  });
});
