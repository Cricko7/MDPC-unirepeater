"use strict";

const showToast = (() => {
  const region = document.createElement("div");
  region.className = "toast-region";
  const notice = document.createElement("div");
  notice.className = "toast-notice";
  notice.hidden = true;
  const message = document.createElement("span");
  message.setAttribute("role", "status");
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.setAttribute("aria-label", "Закрыть уведомление");
  dismiss.textContent = "×";
  notice.append(message, dismiss);
  region.append(notice);
  document.body.append(region);
  let timer;
  let trigger;

  function hide() {
    clearTimeout(timer);
    if (notice.contains(document.activeElement)) trigger?.focus({ preventScroll: true });
    notice.hidden = true;
  }

  dismiss.addEventListener("click", hide);
  notice.addEventListener("keydown", event => {
    if (event.key === "Escape") hide();
  });

  function show(text, tone = "info") {
    clearTimeout(timer);
    trigger = document.activeElement;
    notice.dataset.tone = tone;
    notice.hidden = false;
    message.textContent = text;
    if (tone !== "error") timer = setTimeout(() => {
      if (!notice.contains(document.activeElement)) hide();
    }, tone === "alarm" ? 15000 : 6500);
  }
  show.dismiss = tone => {
    if (!notice.hidden && notice.dataset.tone === tone) hide();
  };
  return show;
})();
