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
    "nav.features": "Why",
    "nav.momentum": "Updates",
    "nav.pricing": "Pricing",
    "nav.faq": "FAQ",
    "nav.cta": "Try MusePi",
    "nav.gh.aria": "GitHub repository",
    "lang.aria": "Language",
    "menu.aria": "Menu",

    /* 首屏 */
    "hero.phase": "Free beta",
    "hero.mobile.dev": " (in development)",
    "hero.term": "Terminal",
    "hero.title":
      'Your <span class="mp-accent">AI partner</span> —<br />it does more than write code:<br class="mp-only-desktop" />rebuild it around your workflow.',
    "hero.sub":
      "MusePi is a hands-on AI partner: it writes code, runs commands, reads up and drives the browser. Switch between the desktop app and the command line anytime; the mobile companion is still in development, with sessions and settings already following you. Models, tools and surfaces are swappable parts, so you can rebuild it around the way you work instead of accepting one more browser tab.",
    "hero.cta.community": "Ask / Report",
    "hero.cta.dl": "Download desktop",
    "hero.cta.look": "See the interface",
    "hero.term.aria": "Install commands",
    "hero.term.tabs": "Choose the install command",
    "hero.term.copy": "Copy command",
    "hero.term.note":
      "This command installs the terminal TUI (the background service starts with it). For the graphical interface, pick an installer from the platform menu above. Once installed, the desktop app and the terminal TUI share the same sessions; the mobile companion is still in development.",
    "dl.aria": "Choose another platform",
    "dl.group.desktop": "Desktop",
    "dl.group.mobile": "Mobile and terminal",
    "dl.mobile.dev": "in development",
    "dl.mac.arch": "Apple silicon · .dmg",
    "dl.tui.os": "Terminal TUI",
    "dl.tui.arch": "all platforms · script",
    "dl.all.os": "All installers",
    "dl.all.arch": "incl. ARM64 · GitHub",

    /* 产品界面预览 */
    "preview.kicker": "Product preview",
    "preview.h2": "One screen that shows every step of the work",
    "preview.desc":
      'Try it here: switch views, open a session or file, check the board. This is the same renderer the desktop app ships, running entirely on local demo data — no daemon, no network. On a phone the renderer is not embedded, so <a href="./app/index.html" target="_blank" rel="noopener">open the full demo in a new tab</a>.',
    "demo.tabs.aria": "Interface demo",
    "demo.hint": "Real renderer · local data",
    "demo.tab.welcome": "Welcome",
    "demo.tab.chat": "Chat",
    "demo.tab.files": "Files",
    "demo.tab.board": "Board",
    "demo.action.open": "Open in new tab",
    "demo.action.fullscreen": "Full screen",
    "demo.loading": "Loading the interface demo…",
    "demo.fallback.title": "The demo didn't load",
    "demo.fallback.body": "A network or browser restriction got in the way. Retry, or open it in a new tab.",
    "demo.fallback.retry": "Retry",
    "demo.guide.next": "Next step",
    "demo.caption": "Real desktop renderer with local demo data — nothing here talks to a daemon.",

    /* 工作台能力浏览 */
    "nav.release": "Capabilities",
    "release.kicker": "Workspace · Shipped capabilities",
    "release.h2": "From doing the work to reviewing and reshaping it together",
    "release.desc":
      "The agent moves tasks forward while you retain direct viewing, editing and precise referencing. These capabilities are in the product now, not on a distant roadmap.",
    "release.tabs.aria": "Explore workspace capabilities",
    "release.tab.agent": "Agent panel & secrets",
    "release.tab.files": "File workspace",
    "release.tab.office": "Office editing & quotes",
    "release.tab.plugins": "Plugins & presets",
    "release.tab.agents": "External subagents",
    "release.agent.eyebrow": "The session's identity card and remote control, right above it",
    "release.agent.title": "The capsule opens your model, rungs and secrets in one place",
    "release.agent.body":
      "Clicking the capsule above a conversation opens that session's Agent tab. The current model folds into one expandable card, the thinking slider follows the model's real rungs, and Auto adds a second line with the level this turn actually resolved to. Working directory, context usage and cost, a jump to pending approvals, and entries for subagents and background jobs sit on the same page. The agent can also ask you for a secret: it submits only a name and purpose, the value is stored encrypted under this machine's master key, and it can only be used inside <code>bash</code> as <code>$MUSEPI_SECRET_&lt;NAME&gt;</code>.",
    "release.agent.p1": "The model card searches in place; Escape folds it and returns focus",
    "release.agent.p2": "One embedded row for thinking: a drag moves only the knob, arrows step one rung",
    "release.agent.p3":
      "The value is only used in bash as $MUSEPI_SECRET_&lt;NAME&gt;; logs and provider requests never see it",
    "release.agent.proof": "Always encrypted",
    "release.files.eyebrow": "Read, edit and reveal without leaving the workspace",
    "release.files.title": "Review code and documents directly",
    "release.files.body":
      "The file tree, Monaco, Markdown, PDF and PR reviews share the same file tabs and draft lifecycle. Definition navigation, cross-file rename, diffs and historical reveals all operate on the real workspace.",
    "release.files.p1": "Monaco editing, LSP navigation and cross-file rename",
    "release.files.p2": "WYSIWYG Markdown and on-demand PDF rendering",
    "release.files.p3": "Reveal PR comments in code and quote them to the agent",
    "release.office.eyebrow": "Quote the content and its precise location",
    "release.office.title": "Edit Office content and return to the exact spot",
    "release.office.body":
      "Safely edit and save Word paragraphs, Excel cells and PowerPoint text shapes. Selections use the existing reference toolbar, and historical quotes restore the paragraph, cell range or slide shape.",
    "release.office.p1": "Complex structures and formulas stay read-only to prevent unsafe writes",
    "release.office.p2": "PowerPoint is explicitly a text-layout preview",
    "release.office.p3": "One lifecycle for drafts, dirty state and close confirmation",
    "release.office.proof": "Precise quotes",
    "release.plugins.eyebrow": "Capabilities are more than switches in a list",
    "release.plugins.title": "Plugins, components and skills share one lifecycle",
    "release.plugins.body":
      "First-party and external packages use the same Cordis package names, component keys and real enablement state. File tools, speech, terminal, browser and LSP compose independently, while product skills follow their package.",
    "release.plugins.p1": "Disabling a package unloads its capabilities and registered entries",
    "release.plugins.p2": "Presets compose explicit plugin rows without overwriting user edits",
    "release.plugins.p3": "Existing third-party agent extension configurations remain compatible",
    "release.agents.eyebrow": "Bring familiar CLIs into one task flow",
    "release.agents.title": "Five external subagents with unified result tracking",
    "release.agents.body":
      "Experimental plugins connect Codex, Claude Code, Kimi Code, CodeBuddy and OpenCode. They reuse MusePi task progress, background jobs, cancellation, timeouts, result cards and complete artifacts.",
    "release.agents.p1": "Configure each executable, model and product permission separately",
    "release.agents.p2": "Loading or toggling a plugin never starts an external process",
    "release.agents.p3": "Install and configure each CLI yourself; permissions are not bypassed by default",

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
    "mom.h2": "An independent product, moving every day",
    "mom.desc":
      "The desktop GUI, the shared background service, the resident desktop pet, the mobile companion, the extension system and the collaboration surfaces are our own work; the whole stack is our own and ships on its own release line. What follows aren't roadmap promises — they're things already shipped in recent releases.",
    "mom.stat1": "LLM providers",
    "mom.stat2": "Shipped platforms",
    "mom.stat3": "Extension hubs",
    "mom.stat4": "Shared background service",
    "mom.log1.tag": "Interface",
    "mom.log1.body":
      "The thinking slider is now one embedded row: the label and the current rung no longer take a second line above the track, Auto names the level this turn actually resolved to on the line below, and the value stops wrapping in a narrow panel.",
    "mom.log2.tag": "Navigation",
    "mom.log2.body":
      "The session map is redesigned: each turn is a 66px index row instead of an expanding card, connections use orthogonal paths with arrowheads to show parent/child direction, and a selection only updates the inspector on the right. It is keyboard-traversable, and branches off the active path stay dimmed but readable.",
    "mom.log3.tag": "Remote",
    "mom.log3.body":
      "Instances and remote workspaces now say two different things: which machine runs the daemon, and which machine holds the files. Endpoints are local / WSL / SSH / Docker / manual; SSH-managed tunnels and docker and WSL process lifecycles are owned by MusePi.",
    "mom.changelog": "Read the full changelog",

    /* 价格 */
    "price.kicker": "Pricing",
    "price.h2": "Free to test now; the community edition is free forever",
    "price.desc":
      "MusePi is in a feature-polishing free-test phase: all core capabilities are open, with no usage limits. The community edition stays free forever; Pro and Team are a farther-off consideration that waits until the existing features are polished. The monthly / yearly toggle below is already in place, so prices will be one click away once paid tiers open — for now only the free community edition is available.",
    "price.billing.aria": "Billing cycle toggle",
    "price.monthly": "Monthly",
    "price.yearly": "Yearly",
    "price.billingNote": "Paid tiers aren't scheduled yet",
    "price.now": "Now · Free forever",
    "price.p1name": "Community",
    "price.forever": "/ forever",
    "price.p1desc": "The full MusePi — no locks, no limits.",
    "price.p1f1": "Desktop GUI · terminal TUI · mobile companion (in development)",
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
      "Desktop covers macOS (Apple silicon), Windows 10/11 (x64 and ARM64) and Linux (.AppImage and .deb, x64 and ARM64); the terminal TUI runs on all three plus WSL; both are ready to download. The mobile companion and the HarmonyOS NEXT shell are still in development: the Android arm64 .apk and the HarmonyOS project ship as test builds in the repository, with no availability promise yet. They all connect to the same background service, with identical sessions and settings.",
    "faq.q3": "Do I need my own model API keys?",
    "faq.a3":
      "Yes. MusePi supports 60+ model providers; just enter your own keys in settings and model costs are billed directly with the provider you choose. MusePi doesn't proxy or take a cut. You can also connect local models.",
    "faq.q4": "Are my code and data safe?",
    "faq.a4":
      "MusePi runs on your own machine; sessions, settings and history are stored locally and aren't uploaded by default. The mobile companion (in development) is designed to pair over the LAN by QR code, with end-to-end encrypted remote control — no third-party server in between. Everything else that leaves the machine follows what you turn on: model requests go to the provider you configure; the desktop app reads the GitHub release manifest at launch to surface new versions (set MUSEPI_NO_AUTO_UPDATE=1 to skip the automatic check); and only when you start a public tunnel does collaboration traffic pass through cloudflared.",
    "faq.q5": "Where does MusePi come from?",
    "faq.a5":
      "MusePi is an AI workspace: the desktop GUI, the terminal and the resident desktop pet share one background service, with the mobile companion still in development; models, tools and surfaces are all swappable. The desktop and mobile apps, the extension system and the collaboration surfaces are our own work; everything is MIT-licensed.",
    "faq.q6": "How do I get started?",
    "faq.a6":
      "One command installs the terminal TUI (the background service starts with it): <code>curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh</code> (macOS / Linux / WSL); on Windows use <code>irm https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.ps1 | iex</code>. Prebuilt binaries need no extra runtime; a from-source install needs Bun 1.4.4 or newer. Want the GUI straight away? Pick your system in the platform menu up top, or browse every installer in Releases.",

    /* CTA band */
    "cta.h2": "Connect it to the machines you have",
    "cta.sub":
      "One command installs the terminal TUI and the background service; pick the desktop app from the platform menu in the first screen. Hit a problem or want a capability that is not there yet? Open an issue on GitHub.",
    "cta.community": "Ask / Report",
    "cta.dl": "Download",

    /* 页脚 */
    "footer.tag":
      "An AI engine that lives inside your workflow: models, tools and surfaces all swappable, desktop, terminal and phone sharing one brain.",
    "footer.android": "Android (in development)",
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
    "footer.issues": "Issues",
    "footer.faq": "FAQ",
    "footer.get": "Get the installer",
    "footer.rights": " · MIT License",
    "footer.fine":
      "Runs locally, MIT open source — your code and your keys stay on your machine.",
  };

  var HEAD_EN = {
    title: "MusePi — Your AI partner: more than writing code, reshaped to your workflow",
    description:
      "MusePi is an AI workspace: the desktop app and the terminal share the same sessions and settings, so work picks up wherever you are, while the mobile companion is still in development. It gets hands on — writing code, running commands, driving the browser — and it comes apart so you can rebuild it around your workflow: models, tools and surfaces are swappable. 60+ model providers, runs locally, end-to-end encrypted collaboration. Free to test; the community edition is free forever.",
    ogTitle: "MusePi — Your AI partner: more than writing code, reshaped to your workflow",
    ogDescription:
      "A hands-on AI partner: it writes code, runs commands and drives the browser, and you can rebuild it around your workflow. Desktop and command line share the same sessions, mobile is in development, 60+ providers, runs locally. Free to test, community edition free forever.",
  };

  /* MPI18N.t() 供 main.js 调用；这里放需要运行时切换的文案。 */
  var JS = {
    "demo.status.idle": { zh: "待载入", en: "Not loaded" },
    "demo.status.loading": { zh: "载入中…", en: "Loading…" },
    "demo.status.ready": { zh: "运行中", en: "Running" },
    "demo.status.error": { zh: "载入失败", en: "Failed" },
    "demo.guide.welcome": {
      zh: "先看首屏：左侧是实例与分组，顶部胶囊里是模型与思考档位，右下是上下文与工具入口。",
      en: "Start here: instances and groups on the left, the capsule above holds the model and thinking rung, and the right side lists context and tools.",
    },
    "demo.guide.chat": {
      zh: "点开会话后：左侧是会话树，中间是回复与工具调用，右侧是文件与 Agent 面板。",
      en: "With a session open: the session tree on the left, replies and tool calls in the middle, files and the Agent panel on the right.",
    },
    "demo.guide.files": {
      zh: "文件视图：树、编辑器与预览共用一套标签；打开 README 试试。",
      en: "Files: the tree, editor and preview share one tab set — open the README to try it.",
    },
    "demo.guide.board": {
      zh: "看板视图：同一个工作区里的画布与产物，适合把任务铺开看。",
      en: "Board: the workspace canvas and artifacts, for spreading the work out.",
    },
    "demo.action.exitFullscreen": { zh: "退出全屏", en: "Exit full screen" },
    "demo.action.fullscreen": { zh: "全屏", en: "Full screen" },
    "demo.frame.title": { zh: "MusePi 界面演示", en: "MusePi interface demo" },
  };

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
      var active = b.getAttribute("data-lang") === current;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
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
