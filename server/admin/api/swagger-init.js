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
    if (request.loadSpec || url.pathname !== "/admin/settings") return request;
    if (request.method.toUpperCase() === "PUT" &&
        !window.confirm("Заменить общие стартовые настройки Датарка?")) {
      throw new Error("Сохранение отменено.");
    }
    return request;
  },
});
