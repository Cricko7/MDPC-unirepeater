"use strict";

const feedback = document.querySelector("#write-feedback");
const monitorLink = document.querySelector("#monitor-link");
const loading = document.querySelector("#swagger-loading");
const writePrompts = {
  "/admin/settings": "Заменить общие стартовые настройки Датарка?",
  "/admin/telemetry": "Изменить общую тестовую телеметрию выбранной зоны?",
};

const bundle = document.createElement("script");
bundle.src = "vendor/swagger-ui-bundle.js";
const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = "vendor/swagger-ui.css";
function reportLoadProblem() {
  loading.firstChild.textContent = "Swagger загружается слишком долго или недоступен. ";
}
const loadTimeout = setTimeout(reportLoadProblem, 12000);
bundle.addEventListener("error", () => {
  clearTimeout(loadTimeout);
  reportLoadProblem();
});
bundle.addEventListener("load", () => SwaggerUIBundle({
  url: "openapi.json",
  dom_id: "#swagger-ui",
  validatorUrl: null,
  persistAuthorization: false,
  showMutatedRequest: false,
  onComplete() {
    clearTimeout(loadTimeout);
    loading.hidden = true;
  },
  requestInterceptor(request) {
    const url = new URL(request.url, window.location.href);
    if (url.origin !== window.location.origin) {
      throw new Error("Запросы разрешены только к серверу Датарк.");
    }
    if (request.loadSpec || request.method.toUpperCase() !== "PUT") return request;
    if (!Object.hasOwn(writePrompts, url.pathname)) return request;
    feedback.hidden = true;
    if (!window.confirm(writePrompts[url.pathname])) {
      throw new Error("Сохранение отменено.");
    }
    request.headers["X-Datark-Admin"] = url.pathname.split("/").at(-1);
    return request;
  },
  responseInterceptor(response) {
    const path = new URL(response.url, window.location.href).pathname;
    const body = response.obj ?? response.body;
    // GET /admin/settings returns the same shape as PUT. Track only responses to writes.
    if (response.status !== 200 || !Object.hasOwn(writePrompts, path) ||
        response.headers["x-datark-write"] !== "saved") return response;
    feedback.hidden = false;
    const monitorUrl = new URL("/monitor/", location.origin);
    if (path === "/admin/settings") {
      monitorUrl.searchParams.set("scenario", "server");
      feedback.textContent = "Настройки сохранены. Общий сценарий виден в режиме «По настройкам сайта».";
    } else if (body?.zone === "all") {
      feedback.textContent = "Все зоны возвращены к симуляции.";
    } else {
      if (body?.zone) monitorUrl.searchParams.set("zone", body.zone);
      feedback.textContent = body?.override === null ? `Зона ${body.zone} возвращена к симуляции.`
        : `Ручная телеметрия зоны ${body?.zone ?? ""} сохранена.`;
    }
    monitorLink.href = monitorUrl.href;
    try {
      localStorage.setItem("mdpc.monitor.server-write", String(Date.now()));
    } catch {
      // Monitoring also polls while visible.
    }
    return response;
  },
}));
document.head.append(stylesheet, bundle);
