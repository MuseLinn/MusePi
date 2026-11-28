(function () {
  "use strict";

  function initialLanguage() {
    try {
      var query = new URLSearchParams(location.search).get("lang");
      if (query === "en" || query === "zh") return query;
      var saved = localStorage.getItem("musepi-lang");
      if (saved === "en" || saved === "zh") return saved;
    } catch (error) {}
    return "zh";
  }

  function applyLanguage(lang) {
    var current = lang === "en" ? "en" : "zh";
    document.documentElement.lang = current === "en" ? "en" : "zh-CN";
    document.title = current === "en" ? "MusePi Changelog" : "MusePi 更新日志";
    document.querySelectorAll(".mp-lang-opt").forEach(function (button) {
      var active = button.getAttribute("data-lang") === current;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    try {
      localStorage.setItem("musepi-lang", current);
    } catch (error) {}
  }

  document.querySelectorAll(".mp-lang-opt").forEach(function (button) {
    button.addEventListener("click", function () {
      applyLanguage(button.getAttribute("data-lang"));
    });
  });
  applyLanguage(initialLanguage());

  var releases = document.getElementById("changelog-releases");
  var toggleAll = document.getElementById("changelog-toggle-all");
  var year = document.querySelector("[data-year]");
  if (year) year.textContent = String(new Date().getFullYear());
  if (!releases || !toggleAll) return;

  var items = Array.prototype.slice.call(releases.querySelectorAll(":scope > details"));
  function syncToggleAll() {
    toggleAll.setAttribute("aria-expanded", items.every(function (item) { return item.open; }) ? "true" : "false");
  }
  toggleAll.hidden = false;
  toggleAll.addEventListener("click", function () {
    var expand = toggleAll.getAttribute("aria-expanded") !== "true";
    items.forEach(function (item) { item.open = expand; });
    syncToggleAll();
  });
  document.addEventListener("toggle", function (event) {
    if (event.target instanceof HTMLDetailsElement && event.target.parentElement === releases) syncToggleAll();
  }, true);
  syncToggleAll();
})();
