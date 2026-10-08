/* MusePi 官网交互：全部原生、零依赖。 */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 年份 ---------- */
  var yearEl = document.querySelector("[data-year]");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ---------- 顶栏滚动态 ---------- */
  var topbar = document.getElementById("topbar");
  function onScroll() {
    if (!topbar) return;
    topbar.classList.toggle("is-scrolled", window.scrollY > 8);
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- 移动端菜单 ---------- */
  var navToggle = document.getElementById("nav-toggle");
  var nav = document.getElementById("mp-nav");
  function closeMenu() {
    document.body.classList.remove("mp-menu-open");
    if (navToggle) navToggle.setAttribute("aria-expanded", "false");
  }
  if (navToggle && nav) {
    navToggle.addEventListener("click", function () {
      var open = document.body.classList.toggle("mp-menu-open");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.querySelectorAll(".mp-nav-link").forEach(function (a) {
      a.addEventListener("click", closeMenu);
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth > 900) closeMenu();
    });
  }

  /* ---------- 安装命令：平台切换与复制 ---------- */
  var termTabs = Array.prototype.slice.call(document.querySelectorAll(".mp-term-tab"));
  var termLines = {};
  document.querySelectorAll("[data-term-line]").forEach(function (el) {
    termLines[el.getAttribute("data-term-line")] = el;
  });
  var termKind = "sh";

  function showTerm(kind) {
    termKind = kind;
    termTabs.forEach(function (t) {
      var on = t.getAttribute("data-term") === kind;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    Object.keys(termLines).forEach(function (k) {
      termLines[k].hidden = k !== kind;
    });
  }
  termTabs.forEach(function (t) {
    t.addEventListener("click", function () { showTerm(t.getAttribute("data-term")); });
  });

  var copyBtn = document.querySelector("[data-copy]");
  if (copyBtn) {
    var copyTimer = null;
    copyBtn.addEventListener("click", function () {
      var line = termLines[termKind];
      var cmd = line.textContent.replace(/^[$>]\s*/, "").trim();
      function selectAsFallback() {
        var afterPrompt = line.querySelector(".mp-cmd-prompt").nextSibling;
        var range = document.createRange();
        range.setStart(afterPrompt, afterPrompt.nodeValue.search(/\S/));
        range.setEnd(line.lastChild, line.lastChild.nodeValue.length);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      function done() {
        copyBtn.classList.add("is-done");
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(function () { copyBtn.classList.remove("is-done"); }, 1600);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd).then(done, selectAsFallback);
      } else {
        selectAsFallback();
      }
    });
  }

  /* ---------- 平台下载菜单 ---------- */
  var dl = document.querySelector(".mp-dl");
  var dlCaret = document.getElementById("dl-caret");
  var dlMenu = document.getElementById("dl-menu");
  var dlMain = dl ? dl.querySelector(".mp-dl-main") : null;
  var dlItems = dlMenu ? Array.prototype.slice.call(dlMenu.querySelectorAll(".mp-dl-item")) : [];

  function closeDl() {
    if (!dl || dlMenu.hidden) return;
    dlMenu.hidden = true;
    dl.classList.remove("is-open");
    dlCaret.setAttribute("aria-expanded", "false");
  }
  if (dl && dlCaret && dlMenu) {
    dlCaret.addEventListener("click", function () {
      if (dlMenu.hidden) {
        dlMenu.hidden = false;
        dl.classList.add("is-open");
        dlCaret.setAttribute("aria-expanded", "true");
      } else {
        closeDl();
      }
    });
    dlItems.forEach(function (a) { a.addEventListener("click", closeDl); });
    document.addEventListener("click", function (e) {
      if (!dl.contains(e.target)) closeDl();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeDl();
    });
  }

  /* 本机系统 → 期望的安装包名（* 为版本号） */
  var ASSET_BY_OS = {
    mac: "MusePi-*-arm64.dmg",
    "win-x64": "MusePi-*-setup.exe",
    "win-arm": "MusePi-*-arm64-setup.exe",
    "linux-x64": "MusePi-*-x86_64.AppImage",
    android: "MusePi-*-app-debug.apk",
  };

  function osKey() {
    var ua = navigator.userAgent;
    if (/Android/i.test(ua)) return "android";
    if (/Mac/i.test(ua)) return "mac";
    if (/Windows/i.test(ua)) return /ARM64|A64/i.test(ua) ? "win-arm" : "win-x64";
    if (/Linux|x11/i.test(ua)) return "linux-x64";
    return "";
  }

  /* Windows on ARM 只在高熵值属性里看得见；不支持的检测退回 UA 判断。 */
  function detectOsKey() {
    var ua = navigator.userAgentData;
    if (ua && /Windows/i.test(ua.platform || "") && ua.getHighEntropyValues) {
      return ua
        .getHighEntropyValues(["architecture"])
        .then(function (h) { return h.architecture === "arm" ? "win-arm" : "win-x64"; })
        .catch(function () { return osKey(); });
    }
    return Promise.resolve(osKey());
  }

  /* 模式里的 * 只代表版本号：写成 \d+(\.\d+)*，否则 "-*-setup.exe" 会误吃 "-arm64-setup.exe"。 */
  function toPatternRe(pattern) {
    return new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "\\d+(?:\\.\\d+)*") + "$");
  }

  function markRecommended(key) {
    var pattern = ASSET_BY_OS[key];
    if (!pattern) return;
    dlItems.forEach(function (a) {
      a.classList.toggle("is-rec", a.getAttribute("data-asset-pattern") === pattern);
    });
  }

  if (dlMenu) {
    var osKeyPromise = detectOsKey();
    osKeyPromise.then(markRecommended);

    fetch("https://api.github.com/repos/MuseLinn/MusePi/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rel) {
        if (!rel || !rel.assets) return;
        dlItems.forEach(function (a) {
          var pattern = a.getAttribute("data-asset-pattern");
          if (!pattern) return;
          var re = toPatternRe(pattern);
          var asset = rel.assets.filter(function (x) { return re.test(x.name); })[0];
          if (!asset) return;
          a.href = asset.browser_download_url;
          a.setAttribute("data-asset", asset.name);
        });
        osKeyPromise.then(function (key) {
          var pattern = ASSET_BY_OS[key];
          if (!pattern) return;
          var hit = dlItems.filter(function (a) { return a.getAttribute("data-asset-pattern") === pattern; })[0];
          if (hit && hit.getAttribute("data-asset")) dlMain.href = hit.href;
        });
        var ver = (rel.tag_name || "").replace(/^v/, "");
        if (ver) {
          document.querySelectorAll("[data-release-version]").forEach(function (el) {
            el.textContent = "v" + ver;
          });
        }
      })
      .catch(function () {});
  }

  /* ---------- 滚动定位高亮（scroll-spy） ---------- */
  var navLinks = Array.prototype.slice.call(document.querySelectorAll(".mp-nav-link"));
  var linkById = {};
  navLinks.forEach(function (a) {
    var id = a.getAttribute("href").slice(1);
    linkById[id] = a;
  });
  var spySections = ["preview", "features", "momentum", "pricing", "faq"]
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);

  function setActive(id) {
    navLinks.forEach(function (a) { a.classList.remove("is-active"); });
    if (id && linkById[id]) linkById[id].classList.add("is-active");
  }
  if ("IntersectionObserver" in window && spySections.length) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) setActive(e.target.id);
      });
    }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 });
    spySections.forEach(function (s) { spy.observe(s); });
  }

  /* ---------- FAQ 折叠（单开） ---------- */
  var faqButtons = Array.prototype.slice.call(document.querySelectorAll(".mp-faq-q"));
  faqButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var expanded = btn.getAttribute("aria-expanded") === "true";
      faqButtons.forEach(function (b) {
        b.setAttribute("aria-expanded", "false");
        var p = document.getElementById(b.getAttribute("aria-controls"));
        if (p) p.setAttribute("aria-hidden", "true");
      });
      if (!expanded) {
        btn.setAttribute("aria-expanded", "true");
        var panel = document.getElementById(btn.getAttribute("aria-controls"));
        if (panel) panel.removeAttribute("aria-hidden");
      }
    });
  });

  /* ---------- 滚动揭示 ---------- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll(".mp-reveal"));
  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) { el.classList.add("is-in"); });
  } else {
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("is-in"); ro.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });
    revealEls.forEach(function (el) { ro.observe(el); });
  }
})();
