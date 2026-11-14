"use strict";

SwaggerUIBundle({
  url: "openapi.json",
  dom_id: "#swagger-ui",
  validatorUrl: null,
  persistAuthorization: false,
  showMutatedRequest: false,
  requestInterceptor(request) {
    const url = new URL(request.url, window.location.href);
    if (url.origin !== window.location.origin) {
      throw new Error("Запросы разрешены только к серверу Датарк.");
    }
    if (request.loadSpec || request.method.toUpperCase() !== "PUT") return request;
    const prompts = {
      "/admin/settings": "Заменить общие стартовые настройки Датарка?",
      "/admin/telemetry": "Изменить общую тестовую телеметрию выбранной зоны?",
    };
    if (prompts[url.pathname] && !window.confirm(prompts[url.pathname])) {
      throw new Error("Сохранение отменено.");
    }
    return request;
  },
});
