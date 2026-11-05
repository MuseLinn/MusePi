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

  function closeDl(restoreFocus) {
    if (!dl || dlMenu.hidden) return;
    dlMenu.hidden = true;
    dl.classList.remove("is-open");
    dlCaret.setAttribute("aria-expanded", "false");
    if (restoreFocus) dlCaret.focus();
  }
  function openDl(index) {
    dlMenu.hidden = false;
    dl.classList.add("is-open");
    dlCaret.setAttribute("aria-expanded", "true");
    if (dlItems.length) dlItems[Math.max(0, Math.min(index, dlItems.length - 1))].focus();
  }
  if (dl && dlCaret && dlMenu) {
    dlItems.forEach(function (a) {
      a.tabIndex = -1;
      a.addEventListener("click", function () { closeDl(false); });
    });
    dlCaret.addEventListener("click", function () {
      if (dlMenu.hidden) openDl(0);
      else closeDl(true);
    });
    dlCaret.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      if (dlMenu.hidden) openDl(e.key === "ArrowDown" ? 0 : dlItems.length - 1);
      else (e.key === "ArrowDown" ? dlItems[0] : dlItems[dlItems.length - 1]).focus();
    });
    dlMenu.addEventListener("keydown", function (e) {
      var current = dlItems.indexOf(document.activeElement);
      var next = current;
      if (e.key === "ArrowDown") next = (current + 1 + dlItems.length) % dlItems.length;
      else if (e.key === "ArrowUp") next = (current - 1 + dlItems.length) % dlItems.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = dlItems.length - 1;
      else if (e.key === "Escape") {
        e.preventDefault();
        closeDl(true);
        return;
      } else if (e.key === "Tab") {
        closeDl(false);
        return;
      } else return;
      e.preventDefault();
      if (dlItems[next]) dlItems[next].focus();
    });
    document.addEventListener("click", function (e) {
      if (!dl.contains(e.target)) closeDl(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !dlMenu.hidden) {
        e.preventDefault();
        closeDl(true);
      }
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

  /* ---------- 0.7.0 能力浏览：鼠标与方向键共用同一激活路径 ---------- */
  var releaseTabs = Array.prototype.slice.call(document.querySelectorAll(".mp-release-tab"));
  function activateReleaseTab(tab, moveFocus) {
    if (!tab) return;
    releaseTabs.forEach(function (candidate) {
      var active = candidate === tab;
      candidate.classList.toggle("is-active", active);
      candidate.setAttribute("aria-selected", active ? "true" : "false");
      candidate.tabIndex = active ? 0 : -1;
      var panel = document.getElementById(candidate.getAttribute("aria-controls"));
      if (panel) panel.hidden = !active;
    });
    if (moveFocus) tab.focus();
  }
  releaseTabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () { activateReleaseTab(tab, false); });
    tab.addEventListener("keydown", function (event) {
      var next = index;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % releaseTabs.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + releaseTabs.length) % releaseTabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = releaseTabs.length - 1;
      else return;
      event.preventDefault();
      activateReleaseTab(releaseTabs[next], true);
    });
  });

  /* ---------- 产品预览：按需载入真实渲染器 ---------- */
  var demo = document.querySelector("[data-demo-embed]");
  if (demo) {
    var DEMO_SRC = "./app/index.html";
    // The artifact is ~22 MiB of JS on a cold cache; the boot budget has to
    // cover a slow connection, not just a warm local disk.
    var DEMO_BOOT_MS = 90000;
    // The shell paints into #root within a second of its own load event on any
    // connection that already finished the module graph. A root that stays
    // empty this long means a chunk failed, and the visitor should hear it
    // from the fallback instead of waiting out the boot budget.
    var DEMO_STALL_MS = 15000;
    var DEMO_POLL_MS = 120;
    var demoFrame = demo.querySelector("[data-demo-stage]");
    var demoScreen = demo.querySelector("[data-demo-screen]");
    var demoLoading = demo.querySelector("[data-demo-loading]");
    var demoFallback = demo.querySelector("[data-demo-fallback]");
    var demoStatus = demo.querySelector("[data-demo-status]");
    var demoFull = demo.querySelector("[data-demo-fullscreen]");
    var demoRetryBtn = demo.querySelector("[data-demo-retry]");
    var demoTabs = Array.prototype.slice.call(demo.querySelectorAll("[data-demo-view]"));
    var demoList = demo.querySelector(".mp-demo-tabs");
    var demoIframe = null;
    var demoState = "";
    var demoView = "welcome";
    var demoApplyToken = 0;
    // Every mount owns a generation; pollers and timers from an earlier mount
    // exit instead of adopting the frame that replaced theirs.
    var demoGen = 0;
    var demoBootTimer = 0;
    var demoStallTimer = 0;
    var demoRootEmptySince = 0;
    var demoRetries = 0;
    var demoNarrow = window.matchMedia("(max-width: 720px)");
    var DEMO_STATUS = {
      idle: "demo.status.idle",
      loading: "demo.status.loading",
      ready: "demo.status.ready",
      error: "demo.status.error",
    };

    function demoText(key) {
      return window.MPI18N ? window.MPI18N.t(key) : key;
    }

    function demoDoc() {
      try {
        return demoIframe && demoIframe.contentDocument;
      } catch (error) {
        return null;
      }
    }

    function renderDemoChrome() {
      demoLoading.hidden = demoState !== "loading";
      demoFallback.hidden = demoState !== "error";
      demoFull.hidden = demoState !== "ready";
      if (demoStatus) demoStatus.textContent = demoText(DEMO_STATUS[demoState]);
    }

    // One transition per state: a second "ready" would replay the tab's view
    // automation, and a late "loading" would flash the overlay over the shell.
    function setDemoState(next) {
      if (demoState === next) return;
      demoState = next;
      demo.setAttribute("data-state", next);
      renderDemoChrome();
      if (next === "ready") {
        syncFullscreen();
        applyDemoView(demoView);
      }
    }

    /* 真实应用没有 URL 路由：视图靠点它自己的入口切换，同源 iframe 直接驱动。
     * 侧栏菜单按图标名匹配，面板入口按文案匹配，都不依赖 DOM 位置。
     * 每次切换发一个 token，旧的等待链在应用新视图后自动失效。 */
    function clickWhen(selector, token) {
      return waitForDemo(function () {
        if (token !== demoApplyToken) return null;
        var doc = demoDoc();
        return doc && doc.querySelector(selector);
      }, 8000, demoGen).then(function (found) {
        if (!found || token !== demoApplyToken) return false;
        (found.closest("button") || found).click();
        return true;
      });
    }

    function clickLabel(nodes, labels) {
      for (var i = 0; i < nodes.length; i++) {
        var text = nodes[i].textContent.trim();
        for (var j = 0; j < labels.length; j++) {
          if (text.indexOf(labels[j]) === 0) {
            nodes[i].click();
            return true;
          }
        }
      }
      return false;
    }

    // gen is read from the mount that started the wait, so a frame replaced by
    // a retry ends the wait instead of being driven by the old view's script.
    function waitForDemo(find, timeout, gen) {
      return new Promise(function (resolve) {
        var deadline = Date.now() + timeout;
        (function tick() {
          if (gen !== demoGen) {
            resolve(null);
            return;
          }
          var found = find();
          if (found || Date.now() > deadline) {
            resolve(found || null);
            return;
          }
          window.setTimeout(tick, DEMO_POLL_MS);
        })();
      });
    }

    // The file pane opens on its tree; opening the demo README shows the
    // Markdown editor instead of an empty pane.
    function openDemoReadme(token) {
      waitForDemo(function () {
        if (token !== demoApplyToken) return null;
        var current = demoDoc();
        if (!current) return null;
        var rows = current.querySelectorAll(".gui-filepane-row");
        for (var i = 0; i < rows.length; i++) {
          if ((rows[i].textContent || "").indexOf("README.md") >= 0) return rows[i];
        }
        return null;
      }, 6000, demoGen).then(function (row) {
        if (row && token === demoApplyToken) row.click();
      });
    }

    function applyDemoView(view) {
      if (!demoDoc()) return;
      var token = ++demoApplyToken;
      if (view === "welcome") {
        clickWhen('.gui-menu-item use[href="#oc-add-circle"]', token);
        return;
      }
      if (view === "chat") {
        clickWhen(".gui-session-row", token);
        return;
      }
      if (view === "board") {
        clickWhen('.gui-menu-item use[href="#oc-layout-column"]', token);
        return;
      }
      if (view !== "files") return;
      waitForDemo(function () {
        if (token !== demoApplyToken) return null;
        var current = demoDoc();
        if (!current) return null;
        // 面板入口要先打开一个会话才出现。
        if (current.querySelector("#session-panel-welcome")) {
          var row = current.querySelector(".gui-session-row");
          if (row) row.click();
          return null;
        }
        return current.querySelector(".gui-surface-tab") || current.querySelector(".gui-panel-empty-item");
      }, 8000, demoGen).then(function (found) {
        if (!found || token !== demoApplyToken) return;
        var current = demoDoc();
        if (!current) return;
        if (clickLabel(current.querySelectorAll(".gui-surface-tab"), ["文件", "Files"])) {
          openDemoReadme(token);
          return;
        }
        clickLabel(current.querySelectorAll(".gui-panel-empty-item"), ["文件", "Files"]);
        openDemoReadme(token);
      });
    }

    function stopDemoTimers() {
      window.clearTimeout(demoBootTimer);
      window.clearInterval(demoStallTimer);
      demoBootTimer = 0;
      demoStallTimer = 0;
    }

    function failDemo() {
      // Ready is terminal: an error after the shell painted must not replace a
      // working preview with the loading overlay and the fallback.
      if (demoState === "ready" || demoState === "error") return;
      demoGen += 1;
      stopDemoTimers();
      if (demoIframe) {
        demoIframe.remove();
        demoIframe = null;
      }
      setDemoState("error");
      // One silent retry: the usual cause is a deploy swapping files under a
      // live page, which a reload fixes. The counter bounds it to a single
      // attempt per visitor action, so a persistent failure cannot loop.
      if (demoRetries < 1) {
        demoRetries += 1;
        window.setTimeout(function () {
          if (demoState === "error") mountDemo();
        }, 2500);
      }
    }

    // The renderer draws at its authored window size and the frame scales it:
    // reflowing the real shell into a short viewport overlaps the welcome
    // hero, so the demo keeps the 1440x900 layout and letterboxes when the
    // frame is not 16:10 (fullscreen on tall displays).
    function applyDemoScale() {
      if (!demoIframe || !demoScreen) return;
      var width = demoScreen.clientWidth;
      var height = demoScreen.clientHeight;
      if (!width || !height) return;
      var scale = Math.min(width / 1440, height / 900);
      var offsetX = (width - 1440 * scale) / 2;
      var offsetY = (height - 900 * scale) / 2;
      demoIframe.style.transform =
        "translate(" + offsetX + "px," + offsetY + "px) scale(" + scale + ")";
    }

    // Apply now for the synchronous layout, then once more on the next frame:
    // fullscreen and font swaps resize the stage after the event that
    // announced them, and a ResizeObserver notification waits for a frame the
    // page may never produce (a hidden tab, headless rendering).
    var demoSyncQueued = false;
    function syncDemoScale() {
      applyDemoScale();
      if (demoSyncQueued) return;
      demoSyncQueued = true;
      window.requestAnimationFrame(function () {
        demoSyncQueued = false;
        applyDemoScale();
      });
    }

    window.addEventListener("resize", syncDemoScale);
    if ("ResizeObserver" in window) new ResizeObserver(syncDemoScale).observe(demoScreen);
    document.addEventListener("fullscreenchange", syncDemoScale);
    document.addEventListener("webkitfullscreenchange", syncDemoScale);

    // The demo posts this from inside the frame once #root has children, so
    // readiness does not depend on the parent being able to read the frame's
    // DOM (a proxy or file:// origin makes contentDocument null).
    window.addEventListener("message", function (event) {
      if (!demoIframe || event.source !== demoIframe.contentWindow) return;
      var data = event.data;
      if (!data) return;
      if (data.type === "musepi:demo-failed") {
        if (demoState !== "ready") failDemo();
        return;
      }
      if (data.type !== "musepi:demo-ready") return;
      stopDemoTimers();
      setDemoState("ready");
    });

    function mountDemo() {
      if (demoState === "loading" || demoState === "ready") return;
      stopDemoTimers();
      if (demoIframe) {
        demoIframe.remove();
        demoIframe = null;
      }
      demoGen += 1;
      setDemoState("loading");
      startDemoFrame(demoGen);
    }

    // The frame is created immediately: the artifact answers for itself. A
    // document without #root is a 404 or the wrong page, which the load
    // handler below turns into the fallback without a separate probe request.
    function startDemoFrame(gen) {
      var frame = document.createElement("iframe");
      frame.className = "mp-demo-iframe";
      frame.title = demoText("demo.frame.title");
      frame.src = DEMO_SRC;
      frame.setAttribute("allow", "clipboard-write");
      frame.addEventListener("error", function () {
        if (gen === demoGen) failDemo();
      });
      frame.addEventListener("load", function () {
        if (gen !== demoGen) return;
        syncDemoScale();
        onDemoFrameLoad(gen);
      });
      demoIframe = frame;
      demoScreen.appendChild(frame);
      syncDemoScale();
      demoBootTimer = window.setTimeout(function () {
        if (gen === demoGen && demoState !== "ready") failDemo();
      }, DEMO_BOOT_MS);
    }

    function onDemoFrameLoad(gen) {
      var doc = demoDoc();
      // Cross-origin frames are opaque here; the ready message decides.
      if (!doc) return;
      if (!doc.getElementById("root")) {
        failDemo();
        return;
      }
      // The shell can already be painted when the frame's own load fires (it
      // runs before the fixture's next 100 ms tick would post the message).
      if (doc.querySelector(".gui-workspace-keeper, .gui-main")) {
        setDemoState("ready");
        return;
      }
      demoRootEmptySince = doc.getElementById("root").childElementCount ? 0 : Date.now();
      if (!demoRootEmptySince) return;
      window.clearInterval(demoStallTimer);
      demoStallTimer = window.setInterval(function () {
        if (gen !== demoGen || demoState !== "loading") {
          window.clearInterval(demoStallTimer);
          demoStallTimer = 0;
          return;
        }
        var current = demoDoc();
        if (!current) {
          window.clearInterval(demoStallTimer);
          demoStallTimer = 0;
          return;
        }
        var root = current.getElementById("root");
        if (!root) {
          failDemo();
          return;
        }
        if (root.childElementCount) {
          window.clearInterval(demoStallTimer);
          demoStallTimer = 0;
          return;
        }
        if (Date.now() - demoRootEmptySince > DEMO_STALL_MS) failDemo();
      }, 1000);
    }

    // The preview is the product, so it loads itself: the poster stands in
    // until the frame is ready. Narrow viewports keep the poster and use the
    // toolbar link (a 1440x900 app scaled to a phone is not usable).
    function requestDemo() {
      if (demoNarrow.matches) return;
      mountDemo();
    }

    function selectDemoTab(view, moveFocus) {
      demoView = view;
      demoTabs.forEach(function (tab) {
        var active = tab.getAttribute("data-demo-view") === view;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", active ? "true" : "false");
        tab.tabIndex = active ? 0 : -1;
        if (active && demoFrame) demoFrame.setAttribute("aria-labelledby", tab.id);
      });
      if (moveFocus) {
        var activeTab = demoTabs.filter(function (t) { return t.getAttribute("data-demo-view") === view; })[0];
        if (activeTab) activeTab.focus();
      }
      renderDemoChrome();
      if (demoState === "ready") applyDemoView(view);
    }

    demoTabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        selectDemoTab(tab.getAttribute("data-demo-view"), false);
      });
    });
    if (demoList) {
      demoList.addEventListener("keydown", function (event) {
        var index = demoTabs.indexOf(document.activeElement);
        if (index < 0) return;
        var next = index;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % demoTabs.length;
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + demoTabs.length) % demoTabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = demoTabs.length - 1;
        else return;
        event.preventDefault();
        selectDemoTab(demoTabs[next].getAttribute("data-demo-view"), true);
      });
    }

    if (demoRetryBtn) {
      demoRetryBtn.addEventListener("click", function () {
        // An explicit retry earns a fresh auto-retry budget, and it must work
        // even when the viewport is too narrow to have mounted on its own.
        demoRetries = 0;
        mountDemo();
      });
    }

    // Mount when the section approaches the viewport, so the preview is
    // already there by the time it is looked at.
    if ("IntersectionObserver" in window) {
      var demoObserver = new IntersectionObserver(function (entries) {
        var visible = entries.some(function (entry) { return entry.isIntersecting; });
        if (!visible) return;
        demoObserver.disconnect();
        requestDemo();
      }, { rootMargin: "200px 0px" });
      demoObserver.observe(demo);
    } else {
      requestDemo();
    }

    function fullscreenOn() {
      return (document.fullscreenElement || document.webkitFullscreenElement) === demoFrame;
    }

    function syncFullscreen() {
      if (!demoFull) return;
      var on = fullscreenOn();
      demoFull.textContent = demoText(on ? "demo.action.exitFullscreen" : "demo.action.fullscreen");
      demoFull.setAttribute("aria-pressed", on ? "true" : "false");
    }

    if (demoFull) {
      demoFull.addEventListener("click", function () {
        if (fullscreenOn()) {
          var exit = document.exitFullscreen || document.webkitExitFullscreen;
          if (exit) exit.call(document);
        } else if (demoFrame.requestFullscreen) {
          demoFrame.requestFullscreen().catch(function () {});
        } else if (demoFrame.webkitRequestFullscreen) {
          demoFrame.webkitRequestFullscreen();
        }
      });
      document.addEventListener("fullscreenchange", syncFullscreen);
      document.addEventListener("webkitfullscreenchange", syncFullscreen);
    }

    document.addEventListener("mp:lang", function () {
      renderDemoChrome();
      syncFullscreen();
      if (demoIframe) demoIframe.title = demoText("demo.frame.title");
    });

    setDemoState("idle");
  }

  /* ---------- 滚动定位高亮（scroll-spy） ---------- */
  var navLinks = Array.prototype.slice.call(document.querySelectorAll(".mp-nav-link"));
  var linkById = {};
  navLinks.forEach(function (a) {
    var id = a.getAttribute("href").slice(1);
    linkById[id] = a;
  });
  var spySections = ["preview", "release", "momentum", "pricing", "faq"]
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
