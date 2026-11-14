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

const pointButtons = document.querySelectorAll("[data-point]");
const pointType = document.querySelector("#point-type");
const pointTitle = document.querySelector("#point-title");
const pointDescription = document.querySelector("#point-description");
const drawing = document.querySelector(".drawing-scroll");
const map = document.querySelector("#landing-map");
const zoomOut = document.querySelector("#zoom-out");
const zoomIn = document.querySelector("#zoom-in");
const zoomValue = document.querySelector("#zoom-value");
const zoomLevels = [100, 125, 150, 200];
let zoomIndex = 0;

function centerOnPoint(marker) {
  const viewport = drawing.getBoundingClientRect();
  const point = marker.getBoundingClientRect();
  drawing.scrollBy({
    left: point.left + (point.width - viewport.width) / 2 - viewport.left,
    top: point.top + (point.height - viewport.height) / 2 - viewport.top,
  });
}

for (const button of pointButtons) {
  button.addEventListener("click", () => {
    const id = button.dataset.point;
    const { type = "Антенна", title, description } = points[id];
    pointType.textContent = id + " · " + type;
    pointTitle.textContent = title;
    pointDescription.textContent = description;
    for (const control of pointButtons) {
      control.setAttribute("aria-pressed", String(control.dataset.point === id));
    }
    centerOnPoint(map.querySelector('[data-point="' + id + '"]'));
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
