/* Interactive product preview.
 * A small, dependency-free replica of the desktop shell: switch views,
 * sessions and files, fill the composer, and play a scripted agent turn.
 * All data is local; nothing talks to a daemon or the network. */
(function () {
  "use strict";

  var root = document.querySelector("[data-mp-demo]");
  if (!root) return;

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var views = Array.prototype.slice.call(root.querySelectorAll("[data-demo-view]"));
  var panels = Array.prototype.slice.call(root.querySelectorAll("[data-demo-panel]"));
  var sides = Array.prototype.slice.call(root.querySelectorAll("[data-demo-side]"));
  var sessions = Array.prototype.slice.call(root.querySelectorAll("[data-demo-session]"));
  var files = Array.prototype.slice.call(root.querySelectorAll("[data-demo-file]"));
  var chips = Array.prototype.slice.call(root.querySelectorAll("[data-demo-chip]"));
  var statusEl = root.querySelector("[data-demo-status]");
  var playBtn = root.querySelector("[data-demo-play]");
  var codeEl = root.querySelector("[data-demo-code]");
  var chatTitle = root.querySelector("[data-demo-chat-title]");
  var input = root.querySelector("[data-demo-input]");
  var sendBtn = root.querySelector("[data-demo-send]");
  var runToken = 0;
  var played = false;
  var statusKey = "demo.status.idle";
  var activeSession = "s1";

  function tr(key) {
    return window.MPI18N ? window.MPI18N.t(key) : key;
  }

  function setStatus(key) {
    statusKey = key;
    if (statusEl) statusEl.textContent = tr(key);
  }

  function resetSteps() {
    root.querySelectorAll("[data-demo-step]").forEach(function (el) {
      el.hidden = true;
    });
    runToken += 1;
    played = false;
    if (playBtn) playBtn.textContent = tr("demo.chat.play");
    setStatus("demo.status.idle");
  }

  function showView(name) {
    views.forEach(function (button) {
      var on = button.getAttribute("data-demo-view") === name;
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-selected", on ? "true" : "false");
      button.tabIndex = on ? 0 : -1;
    });
    panels.forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-demo-panel") !== name;
    });
    sides.forEach(function (side) {
      side.hidden = side.getAttribute("data-demo-side") !== (name === "files" ? "files" : "sessions");
    });
    if (name === "chat") {
      // A fresh view always starts from the resting transcript.
      resetSteps();
    } else {
      runToken += 1;
      setStatus("demo.status.idle");
    }
  }

  // Tabs: click + roving keyboard.
  views.forEach(function (button) {
    button.addEventListener("click", function () {
      showView(button.getAttribute("data-demo-view"));
    });
  });
  var tablist = root.querySelector(".mp-demo-tabs");
  if (tablist) {
    tablist.addEventListener("keydown", function (event) {
      var index = views.indexOf(document.activeElement);
      if (index < 0) return;
      var next = index;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % views.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + views.length) % views.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = views.length - 1;
      else return;
      event.preventDefault();
      showView(views[next].getAttribute("data-demo-view"));
      views[next].focus();
    });
  }

  // Sessions: active highlight, chat title, per-session user message.
  sessions.forEach(function (button) {
    button.addEventListener("click", function () {
      activeSession = button.getAttribute("data-demo-session");
      sessions.forEach(function (other) {
        other.classList.toggle("is-active", other === button);
      });
      var title = button.querySelector(".mp-demo-session-title");
      if (title && chatTitle) chatTitle.textContent = title.textContent;
      root.querySelectorAll("[data-session-content]").forEach(function (el) {
        el.hidden = el.getAttribute("data-session-content") !== activeSession;
      });
      showView("chat");
    });
  });

  // Files: tree selection + code pane.
  var FILES = {
    panel: {
      label: "panel.tsx",
      lines: [
        'import { Panel } from "./shell";',
        'import { useSession } from "./session";',
        "",
        "export function SessionPanel() {",
        "  const { session, status } = useSession();",
        "",
        "  return (",
        "    <Panel title={session.title} status={status}>",
        "      <Chat transcript={session.messages} />",
        "      <Composer onSend={session.send} />",
        "    </Panel>",
        "  );",
        "}",
      ],
    },
    chat: {
      label: "chat.tsx",
      lines: [
        'import { useMemo } from "react";',
        'import { diffLines } from "./diff";',
        "",
        "export function DiffReview({ before, after }) {",
        "  const rows = useMemo(() => diffLines(before, after), [before, after]);",
        "",
        "  return (",
        '    <ul className="review">',
        "      {rows.map(row => (",
        '        <li key={row.id} data-kind={row.kind}>{row.text}</li>',
        "      ))}",
        "    </ul>",
        "  );",
        "}",
      ],
    },
    styles: {
      label: "styles.css",
      lines: [
        ".session-row {",
        "  display: flex;",
        "  align-items: center;",
        "  gap: 8px;",
        "  padding: 5px 10px;",
        "}",
        "",
        '.session-row[aria-selected="true"] {',
        "  background: var(--accent-soft);",
        "  border-color: var(--accent-line);",
        "}",
      ],
    },
  };

  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function highlight(line) {
    if (/^\s*\/\//.test(line)) return '<span class="tok-com">' + escapeHtml(line) + "</span>";
    var html = escapeHtml(line);
    html = html.replace(/(["'`])(.*?)\1/g, '<span class="tok-str">$1$2$1</span>');
    html = html.replace(/\b(import|from|export|function|const|return|if|else|useMemo)\b/g, '<span class="tok-key">$1</span>');
    return html;
  }

  function renderFile(key) {
    var file = FILES[key];
    if (!file || !codeEl) return;
    codeEl.innerHTML = file.lines
      .map(function (line, index) {
        return '<span class="ln">' + (index + 1) + "</span>" + highlight(line);
      })
      .join("\n");
    var tab = root.querySelector("[data-demo-file-tab]");
    if (tab) tab.textContent = file.label;
  }

  files.forEach(function (button) {
    button.addEventListener("click", function () {
      files.forEach(function (other) {
        other.classList.toggle("is-active", other === button);
      });
      renderFile(button.getAttribute("data-demo-file"));
    });
  });
  renderFile("panel");

  // Composer suggestions fill the input.
  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      if (!input) return;
      input.value = chip.textContent;
      input.focus();
    });
  });
  if (sendBtn) {
    sendBtn.addEventListener("click", function () {
      showView("chat");
      resetSteps();
      play();
    });
  }

  function play() {
    if (!playBtn) return;
    resetSteps();
    played = true;
    playBtn.textContent = tr("demo.chat.replay");
    var steps = [
      { key: "think", status: "demo.status.thinking", delay: 450 },
      { key: "tool", status: "demo.status.reading", delay: 1100 },
      { key: "diff", status: "demo.status.writing", delay: 1800 },
      { key: "done", status: "demo.status.done", delay: 2500 },
    ];
    var token = runToken;
    steps.forEach(function (step) {
      window.setTimeout(
        function () {
          if (token !== runToken) return;
          var el = root.querySelector('[data-demo-step="' + step.key + '"]');
          if (el) el.hidden = false;
          setStatus(step.status);
        },
        reduce ? 0 : step.delay,
      );
    });
  }

  if (playBtn) playBtn.addEventListener("click", play);

  // Guided tour: a spotlight over the current demo region + a caption card.
  var tourLayer = root.querySelector("[data-demo-tour]");
  var tourSpot = root.querySelector("[data-demo-tour-spot]");
  var tourCard = root.querySelector("[data-demo-tour-card]");
  var tourStepEl = root.querySelector("[data-demo-tour-step]");
  var tourTitle = root.querySelector("[data-demo-tour-title]");
  var tourBody = root.querySelector("[data-demo-tour-body]");
  var tourNext = root.querySelector("[data-demo-tour-next]");
  var tourPrev = root.querySelector("[data-demo-tour-prev]");
  var tourSkip = root.querySelector("[data-demo-tour-skip]");
  var tourStart = root.querySelector("[data-demo-tour-start]");
  var TOUR_STEPS = [
    { target: ".mp-demo-tabs", title: "demo.tour.1.title", body: "demo.tour.1.body" },
    { target: ".mp-demo-side", view: "welcome", title: "demo.tour.2.title", body: "demo.tour.2.body" },
    { target: "[data-demo-play]", view: "chat", title: "demo.tour.3.title", body: "demo.tour.3.body" },
    { target: ".mp-demo-rail", title: "demo.tour.4.title", body: "demo.tour.4.body" },
  ];
  var tourIndex = -1;

  function placeTour() {
    if (!tourLayer || tourLayer.hidden) return;
    var step = TOUR_STEPS[tourIndex];
    var target = root.querySelector(step.target);
    if (!target || target.offsetParent === null) target = root.querySelector(".mp-demo-main");
    if (!target || !tourSpot || !tourCard) return;
    var base = root.getBoundingClientRect();
    var rect = target.getBoundingClientRect();
    var pad = 6;
    tourSpot.style.left = rect.left - base.left - pad + "px";
    tourSpot.style.top = rect.top - base.top - pad + "px";
    tourSpot.style.width = rect.width + pad * 2 + "px";
    tourSpot.style.height = rect.height + pad * 2 + "px";
    var cardW = tourCard.offsetWidth || 280;
    var cardH = tourCard.offsetHeight || 160;
    var left = rect.left - base.left;
    var top = rect.bottom - base.top + 12;
    if (top + cardH > base.height - 8) top = rect.top - base.top - cardH - 12;
    left = Math.max(8, Math.min(left, base.width - cardW - 8));
    top = Math.max(8, Math.min(top, base.height - cardH - 8));
    tourCard.style.left = left + "px";
    tourCard.style.top = top + "px";
  }

  function renderTourText() {
    var step = TOUR_STEPS[tourIndex];
    if (!step) return;
    if (tourStepEl) tourStepEl.textContent = tourIndex + 1 + " / " + TOUR_STEPS.length;
    if (tourTitle) tourTitle.textContent = tr(step.title);
    if (tourBody) tourBody.textContent = tr(step.body);
    if (tourPrev) tourPrev.disabled = tourIndex === 0;
    if (tourNext) {
      tourNext.textContent = tr(tourIndex === TOUR_STEPS.length - 1 ? "demo.tour.done" : "demo.tour.next");
    }
  }

  function renderTourStep() {
    var step = TOUR_STEPS[tourIndex];
    if (!step) return;
    if (step.view) showView(step.view);
    renderTourText();
    window.requestAnimationFrame(placeTour);
    if (tourNext) tourNext.focus({ preventScroll: true });
  }

  function startTour() {
    if (!tourLayer) return;
    tourIndex = 0;
    tourLayer.hidden = false;
    renderTourStep();
  }

  function endTour() {
    if (!tourLayer) return;
    tourLayer.hidden = true;
    tourIndex = -1;
  }

  if (tourStart) tourStart.addEventListener("click", startTour);
  if (tourNext) {
    tourNext.addEventListener("click", function () {
      if (tourIndex >= TOUR_STEPS.length - 1) {
        endTour();
        return;
      }
      tourIndex += 1;
      renderTourStep();
    });
  }
  if (tourPrev) {
    tourPrev.addEventListener("click", function () {
      if (tourIndex <= 0) return;
      tourIndex -= 1;
      renderTourStep();
    });
  }
  if (tourSkip) tourSkip.addEventListener("click", endTour);
  document.addEventListener("keydown", function (event) {
    if (!tourLayer || tourLayer.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      endTour();
    }
  });
  window.addEventListener("resize", placeTour);

  // Language switch: the static text is handled by i18n.js; dynamic strings
  // and the chat title are refreshed here.
  document.addEventListener("mp:lang", function () {
    setStatus(statusKey);
    if (playBtn) playBtn.textContent = tr(played ? "demo.chat.replay" : "demo.chat.play");
    var active = root.querySelector('[data-demo-session="' + activeSession + '"] .mp-demo-session-title');
    if (active && chatTitle) chatTitle.textContent = active.textContent;
    if (tourLayer && !tourLayer.hidden) {
      renderTourText();
      window.requestAnimationFrame(placeTour);
    }
  });

  var initialTitle = root.querySelector(
    '[data-demo-session="' + activeSession + '"] .mp-demo-session-title',
  );
  if (initialTitle && chatTitle) chatTitle.textContent = initialTitle.textContent;
  setStatus("demo.status.idle");
})();
