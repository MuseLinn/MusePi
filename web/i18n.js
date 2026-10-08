/* MusePi 官网双语层：中 / EN。
 * 静态文案靠 DOM 上的 data-i18n / data-i18n-ph / data-i18n-aria 键切换；
 * 中文是页面里的原文（首次加载时快照，切回中文即还原），英文来自下面的 EN 表。
 * 运行时字符串走 MPI18N.t()，供 main.js 调用。 */
(function () {
  "use strict";

  var EN = {
    /* 顶栏 / 无障碍 */
    "a11y.skip": "Skip to main content",
    "brand.aria": "MusePi",
    "nav.aria": "Main navigation",
    "nav.preview": "Preview",
    "nav.features": "Features",
    "nav.momentum": "Momentum",
    "nav.pricing": "Pricing",
    "nav.faq": "FAQ",
    "nav.cta": "Try MusePi",
    "nav.gh.aria": "GitHub repository",
    "lang.aria": "Language",
    "menu.aria": "Menu",

    /* 首屏 */
    "hero.phase": "Free beta",
    "hero.term": "Terminal",
    "hero.title":
      'Your <span class="mp-accent">AI partner</span> —<br />it does more than write code:<br class="mp-only-desktop" />rebuild it around your workflow.',
    "hero.sub":
      "MusePi is a hands-on AI partner: it writes code, runs commands, reads up and drives the browser. Switch between the desktop app, the command line and your phone anytime — sessions and settings follow you. Models, tools and surfaces are swappable parts, so you can rebuild it around the way you work instead of accepting one more browser tab.",
    "hero.cta.discord": "Join Discord",
    "hero.cta.dl": "Download desktop",
    "hero.cta.look": "See the interface",
    "hero.term.aria": "Install commands",
    "hero.term.tabs": "Choose the install command",
    "hero.term.copy": "Copy command",
    "hero.term.note":
      "Needs Node ≥ 22 or Bun. Once installed, the desktop app, the terminal TUI and the mobile companion share the same sessions.",
    "dl.aria": "Choose another platform",
    "dl.group.desktop": "Desktop",
    "dl.group.mobile": "Mobile and terminal",
    "dl.mac.arch": "Apple silicon · .dmg",
    "dl.tui.os": "Terminal TUI",
    "dl.tui.arch": "all platforms · script",
    "dl.all.os": "All installers",
    "dl.all.arch": "incl. ARM64 · GitHub",

    /* 产品界面预览 */
    "preview.kicker": "Product preview",
    "preview.h2": "One screen that shows every step of the work",
    "preview.desc":
      "Independent floating glass cards assemble a cockpit: on the left a session tree you can walk, in the middle a conversation with live tool rows and a usage ring, on the right a long task broken into phased checkpoints with a filled progress bar showing how far the whole thing has come.",
    "preview.mock.aria":
      "MusePi desktop collaboration UI: session tree on the left, conversation with tool rows in the center, composer at the bottom, task list and progress on the right",
    "preview.note":
      "The preview is an interface illustration for layout and information hierarchy; it does not represent data from any real session.",

    /* mock 内部文案 */
    "mock.project": "musepi-omp",
    "mock.status.working": "Working",
    "mock.search": "Search sessions…",
    "mock.byproject": "By project",
    "mock.s1": "FilePane autosave",
    "mock.s1t": "Just now",
    "mock.s2": "Rewind before refactor",
    "mock.s2t": "5m ago",
    "mock.s3": "Migrate to flex column",
    "mock.s3t": "1h ago",
    "mock.s4": "Subagent · tab focus bug",
    "mock.s4t": "Yesterday",
    "mock.contextused": "Context · 72% used",
    "mock.chatTitle": "Refactor FilePane, add autosave",
    "mock.msgUser": "Refactor FilePane into a flex column and add autosave.",
    "mock.activityTools": "3 tools",
    "mock.activityFiles": "2 files changed +96 −41",
    "mock.running": "Running",
    "mock.msgAI":
      "Three files updated: the editor column keeps the flex chain; unsaved edits now mark a dot on the tab, and you confirm before switching or closing.",
    "mock.composerPh": "Ask anything, / for commands, @ for context…",
    "mock.chipThinking": "High",
    "mock.chipPlan": "Plan",
    "mock.todoTitle": "Todo progress",
    "mock.todoCount": "2/5",
    "mock.phase1": "Refactor",
    "mock.phase2": "Verify",
    "mock.t1": "Map the current FilePane layout",
    "mock.t2": "Extract the autosave module",
    "mock.t3": "Wire dirty markers into tabs",
    "mock.t4": "Add autosave tests",
    "mock.t5": "Update the GUI docs",
    "mock.todoAdd": "Add a task…",

    /* 三个核心功能 */
    "feat.kicker": "Why MusePi",
    "feat.h2": "Built for the way you really work",
    "feat.f1.title": "Sessions are a tree, not a log",
    "feat.f1.body":
      "Every message carries its parent, so history is a tree you can walk — fork, rewind, or re-answer from any node. Context usage stays visible in real time, so long sessions never lose their bearings.",
    "feat.f1.p1": "The canvas map draws the full session DAG",
    "feat.f1.p2": "The trajectory panel projects the same tree as a timeline or branch view",
    "feat.f2.title": "Desktop, terminal, phone — one brain",
    "feat.f2.body":
      "The desktop app, the command line and your phone share one brain behind them: the same sessions, the same settings, the same running tasks. A run started on one keeps streaming on another; you switch surfaces without switching context.",
    "feat.f2.p1": "Android pairs over the LAN by QR code, end to end encrypted",
    "feat.f2.p2": "An SSH-friendly terminal whose sessions match the desktop exactly",
    "feat.f3.title": "An engine that changes parts mid-flight",
    "feat.f3.body":
      "Everything is pluggable: model providers, tools, interface surfaces. A background service watches your extensions directory and hot-reloads on the spot — add capabilities without a restart or waiting on a release.",
    "feat.f3.p1": "60+ LLM providers, with image and video generation built in",
    "feat.f3.p2": "Browser + computer-use, LSP/DAP, task subagents",

    /* 迭代进行时 */
    "mom.kicker": "Momentum",
    "mom.h2": "Built on open source, moving every day",
    "mom.desc":
      "The desktop GUI, the shared background service, the resident desktop pet, the mobile companion, the extension system and the collaboration surfaces are our own work; the Agent engine stands on the shoulders of the open-source oh-my-pi project and stays in sync with it. What follows aren't roadmap promises — they're things already shipped in recent releases.",
    "mom.stat1": "LLM providers",
    "mom.stat2": "Supported platforms",
    "mom.stat3": "Extension hubs",
    "mom.stat4": "Shared background service",
    "mom.log1.tag": "Plugins",
    "mom.log1.body":
      "Install your own plugins by simply dragging in an archive or a local folder; right after install it tells you whether dependencies are complete — what's missing and at which path, all listed at once.",
    "mom.log2.tag": "Reliability",
    "mom.log2.body":
      'When a message is sent, the session is idle, yet there\'s neither a reply nor an error, a silence banner lights up above the composer — re-reading at 0 / 10 / 30 seconds, three times before it decides, never faking a "still thinking".',
    "mom.log3.tag": "Usage",
    "mom.log3.body":
      "<code>/usage</code> grows into a full-screen usage panel: one row per account, one line per quota, Enter toggles between the summary and the full report, and prepaid balance is visible in every view.",
    "mom.changelog": "Read the full changelog",

    /* 价格 */
    "price.kicker": "Pricing",
    "price.h2": "Free to test now; the community edition is free forever",
    "price.desc":
      "MusePi is in a feature-polishing free-test phase: all core capabilities are open, with no usage limits. The community edition stays free forever; Pro and Team are a farther-off consideration that waits until the existing features are polished. The monthly / yearly toggle below is already in place — once paid tiers truly open you'll see prices with one click. For now all three point to the free community edition.",
    "price.billing.aria": "Billing cycle toggle",
    "price.monthly": "Monthly",
    "price.yearly": "Yearly",
    "price.billingNote": "Paid tiers aren't scheduled yet",
    "price.now": "Now · Free forever",
    "price.p1name": "Community",
    "price.forever": "/ forever",
    "price.p1desc": "The full MusePi — no locks, no limits.",
    "price.p1f1": "Desktop GUI · Terminal TUI · Mobile companion",
    "price.p1f2": "60+ providers, bring your own API keys",
    "price.p1f3": "Runs locally; sessions and settings never upload",
    "price.p1f4": "Extension hot-reload, two extension hubs",
    "price.p1f5": "In-app auto-updates",
    "price.freeDl": "Download free",
    "price.soon": "Planned",
    "price.p2name": "Pro",
    "price.tbd": "TBD",
    "price.p2desc": "Advanced capabilities for heavy users — to be discussed once the features mature.",
    "price.p2f1": "Early access to new models and experimental features",
    "price.p2f2": "Higher background-task concurrency",
    "price.p2f3": "Cloud session sync (optional)",
    "price.p2f4": "Email support",
    "price.notopen": "Not open yet",
    "price.p3name": "Team",
    "price.p3desc": "For small teams writing code together — also a farther-off idea.",
    "price.p3f1": "Shared extensions and presets",
    "price.p3f2": "Centralized keys and usage management",
    "price.p3f3": "End-to-end encrypted collaboration",
    "price.p3f4": "Seats and roles",

    /* 常见问题 */
    "faq.kicker": "FAQ",
    "faq.h2": "What you might ask first",
    "faq.q1": "Does MusePi cost money?",
    "faq.a1":
      "It's a free test during the feature-polishing phase — all core capabilities are open, with no limit on sessions or messages. The community edition stays free forever; Pro and Team are a farther-off consideration that only comes up once the existing capabilities mature — MusePi won't quietly turn what's already free behind a paywall.",
    "faq.q2": "Which platforms are supported?",
    "faq.a2":
      "Desktop covers macOS (Apple silicon), Windows 10/11 (x64 and ARM64) and Linux (.AppImage and .deb, x64 and ARM64); the terminal TUI runs on all three plus WSL; the mobile companion offers an arm64 .apk for Android. They all connect to the same background service, with identical sessions and settings.",
    "faq.q3": "Do I need my own model API keys?",
    "faq.a3":
      "Yes. MusePi supports 60+ model providers; just enter your own keys in settings and model costs are billed directly with the provider you choose. MusePi doesn't proxy or take a cut. You can also connect local models.",
    "faq.q4": "Are my code and data safe?",
    "faq.a4":
      "MusePi runs on your own machine; sessions, settings and history are stored locally and aren't uploaded by default. The mobile companion pairs over the LAN by QR code, and remote control is end-to-end encrypted the whole way — no third-party server in between. The only outbound network request is to the model provider you configure.",
    "faq.q5": "Where does MusePi come from?",
    "faq.a5":
      "MusePi is an AI workspace: the desktop GUI, the terminal, the mobile companion and the resident desktop pet share one background service, with models, tools and surfaces all swappable. The desktop and mobile apps, the extension system and the collaboration surfaces are our own work; the Agent engine stands on the shoulders of the open-source oh-my-pi project (see its repo for details), and everything is MIT-licensed.",
    "faq.q6": "How do I get started?",
    "faq.a6":
      "One command installs the background service, the terminal TUI and the desktop app: <code>curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh</code> (macOS / Linux / WSL); on Windows use <code>irm https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.ps1 | iex</code>. Requires Node ≥ 22 or Bun. Want the GUI straight away? Pick your system in the platform menu up top, or browse every installer in Releases.",

    /* CTA band */
    "cta.h2": "Connect it to the machines you have",
    "cta.sub":
      "One command installs the background service and the desktop app, or pick your package from the platform menu in the first screen. Questions, ideas or just want to poke around? Join us on Discord.",
    "cta.discord": "Join Discord",
    "cta.dl": "Download",

    /* 页脚 */
    "footer.tag":
      "An AI engine that lives inside your workflow: models, tools and surfaces all swappable, desktop, terminal and phone sharing one brain.",
    "footer.terminal": "Terminal",
    "footer.aria": "Footer navigation",
    "footer.colProduct": "Product",
    "footer.dl": "Download",
    "footer.colRes": "Resources",
    "footer.gh": "GitHub source",
    "footer.docs": "Docs",
    "footer.changelog": "Changelog",
    "footer.contrib": "Contributing",
    "footer.colStart": "Get started",
    "footer.faq": "FAQ",
    "footer.get": "Get the installer",
    "footer.rights": " · MIT License",
    "footer.fine":
      "Runs locally, MIT open source — your code and your keys stay on your machine.",
  };

  var HEAD_EN = {
    title: "MusePi — Your AI partner: more than writing code, reshaped to your workflow",
    description:
      "MusePi is an AI workspace: the desktop app, the terminal and the mobile companion share the same sessions and settings, so work picks up wherever you are. It gets hands on — writing code, running commands, driving the browser — and it comes apart so you can rebuild it around your workflow: models, tools and surfaces are swappable. 60+ model providers, runs locally, end-to-end encrypted collaboration. Free to test; the community edition is free forever.",
    ogTitle: "MusePi — Your AI partner: more than writing code, reshaped to your workflow",
    ogDescription:
      "A hands-on AI partner: it writes code, runs commands and drives the browser, and you can rebuild it around your workflow. Desktop · command line · phone share the same sessions, 60+ providers, runs locally. Free to test, community edition free forever.",
  };

  /* MPI18N.t() 供 main.js 调用；当前没有运行时文案，保留这个空表作为接口。 */
  var JS = {};

  var nodes = [];
  document.querySelectorAll("[data-i18n]").forEach(function (el) {
    nodes.push({ el: el, key: el.getAttribute("data-i18n"), kind: "html", zh: el.innerHTML });
  });
  document.querySelectorAll("[data-i18n-ph]").forEach(function (el) {
    nodes.push({ el: el, key: el.getAttribute("data-i18n-ph"), kind: "ph", zh: el.getAttribute("placeholder") || "" });
  });
  document.querySelectorAll("[data-i18n-aria]").forEach(function (el) {
    nodes.push({ el: el, key: el.getAttribute("data-i18n-aria"), kind: "aria", zh: el.getAttribute("aria-label") || "" });
  });

  var metaDesc = document.querySelector('meta[name="description"]');
  var metaOgTitle = document.querySelector('meta[property="og:title"]');
  var metaOgDesc = document.querySelector('meta[property="og:description"]');
  var headZh = {
    title: document.title,
    description: metaDesc ? metaDesc.getAttribute("content") || "" : "",
    ogTitle: metaOgTitle ? metaOgTitle.getAttribute("content") || "" : "",
    ogDescription: metaOgDesc ? metaOgDesc.getAttribute("content") || "" : "",
  };

  var current = "zh";

  function apply(lang) {
    current = lang === "en" ? "en" : "zh";
    var useEn = current === "en";

    nodes.forEach(function (n) {
      if (n.kind === "html") {
        var hv = useEn ? EN[n.key] : n.zh;
        n.el.innerHTML = hv != null ? hv : n.zh;
      } else if (n.kind === "ph") {
        var pv = useEn ? EN[n.key] : n.zh;
        n.el.setAttribute("placeholder", pv != null ? pv : n.zh);
      } else {
        var av = useEn ? EN[n.key] : n.zh;
        n.el.setAttribute("aria-label", av != null ? av : n.zh);
      }
    });

    document.documentElement.lang = useEn ? "en" : "zh-CN";
    document.title = useEn ? HEAD_EN.title : headZh.title;
    if (metaDesc) metaDesc.setAttribute("content", useEn ? HEAD_EN.description : headZh.description);
    if (metaOgTitle) metaOgTitle.setAttribute("content", useEn ? HEAD_EN.ogTitle : headZh.ogTitle);
    if (metaOgDesc) metaOgDesc.setAttribute("content", useEn ? HEAD_EN.ogDescription : headZh.ogDescription);

    document.querySelectorAll(".mp-lang-opt").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-lang") === current);
    });
  }

  window.MPI18N = {
    lang: function () {
      return current;
    },
    t: function (key) {
      var s = JS[key];
      if (!s) return key;
      return current === "en" ? s.en : s.zh;
    },
  };

  document.querySelectorAll(".mp-lang-opt").forEach(function (b) {
    b.addEventListener("click", function () {
      var lang = b.getAttribute("data-lang") === "en" ? "en" : "zh";
      apply(lang);
      try {
        localStorage.setItem("musepi-lang", lang);
      } catch (e) {}
      document.dispatchEvent(new CustomEvent("mp:lang", { detail: { lang: lang } }));
    });
  });

  var initial = "zh";
  try {
    var q = new URLSearchParams(location.search).get("lang");
    var saved = localStorage.getItem("musepi-lang");
    if (q === "en" || q === "zh") initial = q;
    else if (saved === "en" || saved === "zh") initial = saved;
  } catch (e) {}
  apply(initial);
})();
