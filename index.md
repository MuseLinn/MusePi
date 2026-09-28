---
layout: default
title: MusePi — your pair engineer, on every surface
lang: en
zh_url: /index.zh-CN.html
mp_cta: true
---

<section class="mp-hero">
  <div class="mp-hero-grid">
    <div class="mp-hero-copy">
      <div class="mp-hero-badge">
        <span class="mp-pulse" aria-hidden="true"></span>
        <span class="mp-hero-badge-ver" data-release-version>v0.4.37</span>
        <span class="mp-hero-badge-sep" aria-hidden="true"></span>
        <span class="mp-hero-badge-meta">macOS · Windows · Linux · Android</span>
      </div>
      <h1 class="mp-hero-title">Your pair engineer,<br>on every surface.</h1>
      <p class="mp-hero-sub">
        MusePi pairs a liquid-glass desktop cockpit, a resident orb companion and a
        mobile app with one shared daemon — sessions, settings and history follow you
        from GUI to terminal to phone.
      </p>
      <div class="mp-cta-row">
        <a class="mp-cta mp-cta--primary" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="arm64.dmg">Download for macOS</a>
        <a class="mp-cta mp-cta--soft" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="setup.exe">Windows · x64</a>
        <a class="mp-cta mp-cta--soft" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="x86_64.AppImage">Linux</a>
        <a class="mp-cta mp-cta-ghost" href="https://github.com/MuseLinn/MusePi/tree/main/docs">Read the docs</a>
        <div class="mp-cta-more">
          <button class="mp-cta mp-cta--soft mp-cta-more-btn" type="button" data-dl-more aria-haspopup="menu" aria-expanded="false">
            Other versions
            <svg class="mp-cta-more-chevron" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" fill="none"><path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="mp-cta-menu" role="menu" data-dl-menu hidden>
            <p class="mp-cta-menu-label">Desktop</p>
            <a role="menuitem" data-asset="arm64.dmg" href="https://github.com/MuseLinn/MusePi/releases/latest">macOS (Apple Silicon)<span>.dmg</span></a>
            <a role="menuitem" data-asset="setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 10/11 (x64)<span>setup.exe</span></a>
            <a role="menuitem" data-asset="arm64-setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 11 (ARM64)<span>arm64-setup.exe</span></a>
            <a role="menuitem" data-asset="x86_64.AppImage" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64<span>.AppImage</span></a>
            <a role="menuitem" data-asset="amd64.deb" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64<span>.deb</span></a>
            <a role="menuitem" data-asset="arm64.AppImage" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux ARM64<span>.AppImage</span></a>
            <a role="menuitem" data-asset="arm64.deb" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux ARM64<span>.deb</span></a>
            <p class="mp-cta-menu-label">Mobile</p>
            <a role="menuitem" data-asset="app-debug.apk" href="https://github.com/MuseLinn/MusePi/releases/latest">Android arm64<span>.apk</span></a>
            <p class="mp-cta-menu-label">Verify</p>
            <a role="menuitem" data-asset="SHA256SUMS.txt" href="https://github.com/MuseLinn/MusePi/releases/latest">SHA256SUMS.txt<span>checksums</span></a>
            <a role="menuitem" href="https://github.com/MuseLinn/MusePi/releases">All releases &amp; beta builds</a>
          </div>
        </div>
      </div>
    </div>
    <aside class="mp-term" aria-label="Install commands">
      <div class="mp-term-bar">
        <span class="mp-term-lights" aria-hidden="true"><i></i><i></i><i></i></span>
        <div class="mp-term-tabs" role="tablist">
          <button class="mp-term-tab" type="button" data-term-tab aria-selected="true">macOS · Linux</button>
          <button class="mp-term-tab" type="button" data-term-tab aria-selected="false">Windows</button>
          <button class="mp-term-tab" type="button" data-term-tab aria-selected="false">From source</button>
        </div>
        <button class="mp-term-copy" type="button" data-term-copy data-copy="">Copy</button>
      </div>
      <pre data-term-pane data-copy="curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh"><span class="mp-term-prompt">$ </span>curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh</pre>
      <pre data-term-pane data-copy="irm https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.ps1 | iex"><span class="mp-term-prompt">$ </span>irm https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.ps1 | iex</pre>
      <pre data-term-pane data-copy="git clone https://github.com/MuseLinn/MusePi.git && cd MusePi && bun run setup && bun run musepi"><span class="mp-term-prompt">$ </span>git clone https://github.com/MuseLinn/MusePi.git
<span class="mp-term-prompt">$ </span>cd MusePi &amp;&amp; bun run setup &amp;&amp; bun run musepi</pre>
      <p class="mp-term-hint">One line installs the daemon, the TUI and the desktop app. Node ≥ 22 or Bun required.</p>
    </aside>
  </div>

  <div class="mp-orb" aria-hidden="true">
    <svg viewBox="0 0 269 275" xmlns="http://www.w3.org/2000/svg" focusable="false">
      <defs>
        <radialGradient id="mp-orb-shell" cx="0.34" cy="0.26" r="0.92">
          <stop offset="0" stop-color="oklch(89.07% 0.0798 79.84)"/>
          <stop offset="0.5" stop-color="oklch(65% 0.105 79.84)"/>
          <stop offset="1" stop-color="oklch(33% 0.08 79.84)"/>
        </radialGradient>
        <linearGradient id="mp-orb-wear" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="oklch(97% 0.004 95)"/>
          <stop offset="1" stop-color="oklch(90% 0.006 95)"/>
        </linearGradient>
        <linearGradient id="mp-orb-rose" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="oklch(83% 0.05 40)"/>
          <stop offset="0.55" stop-color="oklch(72% 0.075 35)"/>
          <stop offset="1" stop-color="oklch(58% 0.07 32)"/>
        </linearGradient>
        <radialGradient id="mp-orb-eye" cx="0.5" cy="0.3" r="0.78">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset="0.45" stop-color="#f4f6f9"/>
          <stop offset="1" stop-color="#c9ced7"/>
        </radialGradient>
      </defs>
      <g transform="translate(20 24)">
        <circle cx="114.27" cy="114.27" r="114.27" fill="url(#mp-orb-shell)"/>
        <ellipse cx="80.27" cy="57.27" rx="31" ry="14" transform="rotate(-22 80.27 57.27)" fill="#ffffff" opacity="0.5"/>
        <ellipse cx="58.27" cy="84.27" rx="7" ry="4" transform="rotate(-22 58.27 84.27)" fill="#ffffff" opacity="0.35"/>
        <ellipse cx="94.27" cy="50.27" rx="15" ry="5.6" transform="rotate(-22 94.27 50.27)" fill="#ffffff" opacity="0.55"/>
        <ellipse cx="88" cy="112" rx="12.5" ry="17" fill="url(#mp-orb-eye)"/>
        <ellipse cx="141" cy="112" rx="12.5" ry="17" fill="url(#mp-orb-eye)"/>
        <path d="M 97 138 Q 114.5 152 132 138" fill="none" stroke="#f4f6f9" stroke-width="7" stroke-linecap="round"/>
        <path d="M -2 78 A 123.3 123.3 0 0 1 230.54 78" fill="none" stroke="url(#mp-orb-wear)" stroke-width="14" stroke-linecap="round"/>
        <path d="M -2 74 A 128 128 0 0 1 230.54 74" fill="none" stroke="url(#mp-orb-rose)" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M -2 84 A 118.5 118.5 0 0 1 230.54 84" fill="none" stroke="url(#mp-orb-rose)" stroke-width="2.6" stroke-linecap="round"/>
        <rect x="-6.5" y="74" width="9" height="30" rx="4.5" fill="url(#mp-orb-rose)" stroke="oklch(58% 0.07 32)" stroke-width="1.2"/>
        <rect x="225.97" y="74" width="9" height="30" rx="4.5" fill="url(#mp-orb-rose)" stroke="oklch(58% 0.07 32)" stroke-width="1.2"/>
        <g transform="translate(-2 104.27) rotate(-14)">
          <ellipse rx="12.6" ry="25" fill="url(#mp-orb-wear)" stroke="oklch(72% 0.012 90)" stroke-width="2.2"/>
          <ellipse rx="9" ry="20.5" fill="oklch(94% 0.005 95)"/>
          <ellipse rx="4.8" ry="12.5" fill="oklch(45% 0.012 80)"/>
          <path d="M -7.2 -17.8 A 11.2 23.2 0 0 1 3.8 -21.9" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" opacity="0.85"/>
        </g>
        <g transform="translate(230.54 104.27) rotate(14)">
          <ellipse rx="12.6" ry="25" fill="url(#mp-orb-wear)" stroke="oklch(72% 0.012 90)" stroke-width="2.2"/>
          <ellipse rx="9" ry="20.5" fill="oklch(94% 0.005 95)"/>
          <ellipse rx="4.8" ry="12.5" fill="oklch(45% 0.012 80)"/>
          <path d="M -7.2 -17.8 A 11.2 23.2 0 0 1 3.8 -21.9" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" opacity="0.85"/>
          <rect x="2" y="-31" width="7" height="10" rx="2.4" fill="url(#mp-orb-rose)" stroke="oklch(58% 0.07 32)" stroke-width="1.2"/>
        </g>
      </g>
    </svg>
  </div>
</section>

<section class="mp-stats mp-reveal" aria-label="MusePi at a glance">
  <div class="mp-stat">
    <span class="mp-stat-num mp-stat-num--accent">60+</span>
    <span class="mp-stat-label">LLM providers</span>
  </div>
  <div class="mp-stat">
    <span class="mp-stat-num">5</span>
    <span class="mp-stat-label">Platforms supported</span>
  </div>
  <div class="mp-stat">
    <span class="mp-stat-num">2</span>
    <span class="mp-stat-label">Extension centers</span>
  </div>
  <div class="mp-stat">
    <span class="mp-stat-num">1</span>
    <span class="mp-stat-label">Shared daemon</span>
  </div>
</section>

<section class="mp-demo mp-reveal" id="demo">
  <header class="mp-demo-head">
    <p class="mp-demo-kicker">Live tour</p>
    <h2>One daemon. Three surfaces.</h2>
    <p class="mp-demo-desc">Pick the surface that fits the moment — every one talks to the
       same sessions, the same settings, the same running tasks.</p>
  </header>
  <div class="mp-demo-tabs" role="tablist" aria-label="Surfaces">
    <button class="mp-demo-tab is-active" type="button" data-demo-tab="gui" role="tab" aria-selected="true">Desktop GUI</button>
    <button class="mp-demo-tab" type="button" data-demo-tab="tui" role="tab" aria-selected="false">Terminal TUI</button>
    <button class="mp-demo-tab" type="button" data-demo-tab="mobile" role="tab" aria-selected="false">Mobile companion</button>
  </div>
  <div class="mp-demo-stage">
    <figure class="mp-demo-preview">
      <div class="mp-demo-chrome" aria-hidden="true">
        <span class="mp-demo-lights"><i></i><i></i><i></i></span>
        <span class="mp-demo-chrome-title" data-demo-chrome>MusePi — Welcome</span>
      </div>
      <div class="mp-demo-view">
        <div data-demo-pane="gui" class="mp-demo-gui is-active" aria-hidden="true">
          <aside class="mp-demo-app-rail">
            <span class="mp-demo-rail-head"></span>
            <span class="mp-demo-rail-row is-active"></span>
            <span class="mp-demo-rail-row"></span>
            <span class="mp-demo-rail-row"></span>
            <span class="mp-demo-rail-row is-dim"></span>
            <span class="mp-demo-rail-row is-dim"></span>
          </aside>
          <div class="mp-demo-app-main">
            <canvas class="mp-dots" aria-hidden="true"></canvas>
            <div class="mp-demo-greet">
              <p class="mp-demo-greet-hi">Good evening</p>
              <p class="mp-demo-greet-sub">Three sessions idle — the daemon is watching.</p>
            </div>
            <div class="mp-demo-composer">
              <span class="mp-demo-composer-ph">Ask anything — / for commands, @ for files</span>
              <span class="mp-demo-composer-model">deepseek-v4-flash</span>
              <span class="mp-demo-composer-send">
                <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" fill="none"><path d="M6 10V2M2.5 5.5L6 2l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </span>
            </div>
          </div>
        </div>
        <div data-demo-pane="tui" class="mp-demo-tui-canvas" aria-hidden="true">
          <canvas class="mp-splash"></canvas>
        </div>
        <div data-demo-pane="mobile" class="mp-demo-mobile" aria-hidden="true">
          <div class="mp-demo-phone">
            <div class="mp-demo-phone-head">MusePi <span>LIVE</span></div>
            <div class="mp-demo-bubble">Run `bun test` on session main?</div>
            <div class="mp-demo-bubble mp-demo-bubble--me">Yes — and stop if anything flakes</div>
            <div class="mp-demo-bubble"><span class="mp-demo-tui-ok">✓</span> 243 passed · turn stopped</div>
            <div class="mp-demo-phone-send">Ask, paste or stop — one bar <span aria-hidden="true">→</span></div>
          </div>
          <p class="mp-demo-mobile-note">Pairs over LAN with a QR join — E2E-encrypted.</p>
        </div>
      </div>
      <figcaption class="mp-demo-caption" data-demo-caption>Welcome — dot-matrix brand backdrop, time-aware greeting</figcaption>
    </figure>
    <aside class="mp-demo-panels">
      <article class="mp-demo-panel is-active" data-demo-panel="gui">
        <h3>Desktop client</h3>
        <p>The full cockpit — liquid-glass surfaces over the real window material
           (Win11 acrylic / macOS vibrancy): specular rims, fluid spring motion,
           with chat and the session tree as first-class citizens.</p>
        <ul>
          <li>Every TUI setting merged into one searchable panel</li>
          <li>Floating status cards keep running tasks at a glance</li>
          <li>Keyboard-driven throughout, Chinese-first typography</li>
          <li>Design mode: the agent drafts interfaces — brief first, then
              structure, then a previewable artifact — instead of writing code</li>
        </ul>
      </article>
      <article class="mp-demo-panel" data-demo-panel="tui">
        <h3>Terminal TUI</h3>
        <p>The same agent in your terminal — keyboard-first, SSH-friendly, identical
           sessions and settings.</p>
        <ul>
          <li>/tree, /trace and slash commands from the desktop</li>
          <li>Same daemon, so a run started here keeps streaming there</li>
          <li>Installable in one line — no Electron required</li>
        </ul>
      </article>
      <article class="mp-demo-panel" data-demo-panel="mobile">
        <h3>Mobile companion</h3>
        <p>An Android app that pairs over LAN with a QR join — watch runs, send prompts
           and stop turns from anywhere.</p>
        <ul>
          <li>Three-in-one send bar: ask, paste context, or stop a turn</li>
          <li>Live session status with the same tree topology</li>
          <li>E2E-encrypted — nothing touches a third-party server</li>
        </ul>
      </article>
    </aside>
  </div>
</section>

<section class="mp-features mp-reveal" id="features">
  <header class="mp-section-head">
    <p class="mp-demo-kicker">Why MusePi</p>
    <h2>Built for the way you actually work</h2>
  </header>
  <article class="mp-feature">
    <div class="mp-feature-copy">
      <p class="mp-feature-kicker">Sessions as a tree</p>
      <h3>Every answer grows on a tree</h3>
      <p>Every message carries its parent — so history is a tree you can walk, not a
         log you must replay. Branch, fork, revert and re-answer from any node.</p>
      <ul class="mp-feature-points">
        <li>The canvas map draws the whole conversation DAG</li>
        <li>The trajectory panel projects the same tree as a timeline</li>
      </ul>
    </div>
    <figure class="mp-feature-media">
      <div class="mp-feature-mock" aria-hidden="true">
        <aside class="mp-mock-side">
          <span class="mp-mock-side-title">Sessions</span>
          <span class="mp-mock-tree is-active"></span>
          <span class="mp-mock-tree mp-mock-tree--branch"></span>
          <span class="mp-mock-tree mp-mock-tree--branch2"></span>
          <span class="mp-mock-tree"></span>
          <div class="mp-mock-donut"><i></i></div>
          <span class="mp-mock-donut-label">72% ctx</span>
        </aside>
        <div class="mp-mock-chat">
          <div class="mp-mock-bubble mp-mock-bubble--user">Refactor FilePane to a flex column and add autosave</div>
          <div class="mp-mock-tool"><span class="mp-mock-tool-name">grep</span><span class="mp-mock-tool-arg">autosave · FilePane</span><span class="mp-mock-tool-ok">14 files</span></div>
          <div class="mp-mock-tool"><span class="mp-mock-tool-name">edit</span><span class="mp-mock-tool-arg">FilePane.tsx + autosave.ts</span><span class="mp-mock-tool-ok">+96 −41</span></div>
          <div class="mp-mock-ai">Applied across three files — the editor column keeps its flex chain, unsaved changes now badge the tab and ask before switching or closing.</div>
          <div class="mp-mock-input">Reply, or shift the plan…<span class="mp-mock-input-send"></span></div>
        </div>
      </div>
      <figcaption>Session — transcript, tools with live results, context ring on the tree</figcaption>
    </figure>
  </article>
  <article class="mp-feature mp-feature--flip">
    <div class="mp-feature-copy">
      <p class="mp-feature-kicker">Agent engine &amp; extensions</p>
      <h3>An engine you can rebuild mid-flight</h3>
      <p>Everything is pluggable: model providers, tools, UI surfaces — hot-reloaded
         while the daemon watches your extension folders.</p>
      <ul class="mp-feature-points">
        <li>60+ LLM providers, image &amp; video generation built in</li>
        <li>Browser + computer-use tools, LSP/DAP, task subagents</li>
        <li>Two extension centers — slots, tool views, RPCs, themes</li>
      </ul>
    </div>
    <figure class="mp-feature-media">
      <div class="mp-feature-mock mp-feature-mock--settings" aria-hidden="true">
        <aside class="mp-mock-side">
          <span class="mp-mock-side-title">Settings</span>
          <span class="mp-mock-set-row">General</span>
          <span class="mp-mock-set-row is-active">Models</span>
          <span class="mp-mock-set-row">API keys</span>
          <span class="mp-mock-set-row">Appearance</span>
          <span class="mp-mock-set-row">Extensions</span>
        </aside>
        <div class="mp-mock-chat">
          <div class="mp-mock-search">Search every TUI setting…</div>
          <div class="mp-mock-pref"><span>Default model</span><b>deepseek-v4-flash</b></div>
          <div class="mp-mock-pref"><span>Thinking effort</span><b>high</b></div>
          <div class="mp-mock-pref"><span>Desktop notifications</span><i class="mp-mock-toggle is-on"></i></div>
          <div class="mp-mock-pref"><span>Always-on pet</span><i class="mp-mock-toggle is-on"></i></div>
          <div class="mp-mock-pref"><span>Telemetry</span><i class="mp-mock-toggle"></i></div>
        </div>
      </div>
      <figcaption>Settings — every TUI setting, searchable and grouped</figcaption>
    </figure>
  </article>
  <div class="mp-bento">
    <div class="mp-card">
      <h3><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="4.2"/><path d="M2.2 9.6a6.6 6.6 0 0 0 11.6 0" stroke-linecap="round"/></svg>Always-on pet</h3>
      <p>An animated companion with drag positioning, click-through, hover interactions
         and task bubbles — the agent's status at a glance.</p>
    </div>
    <div class="mp-card">
      <h3><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><rect x="5" y="1.8" width="6" height="12.4" rx="1.6"/><path d="M7.2 12.2h1.6M11 5.4a4.2 4.2 0 0 1 0 5.2M12.8 3.6a6.8 6.8 0 0 1 0 8.8"/></svg>Remote &amp; mobile</h3>
      <p>The Android companion pairs over LAN with a QR join and a three-in-one send
         bar — watch runs, send prompts, stop turns. Chat bots do the same from
         Discord, Telegram, Feishu and WeChat, each in its own idiom: native typing
         indicators, quoted thread replies, chunked answers instead of truncated ones.</p>
    </div>
    <div class="mp-card">
      <h3><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.6l5.2 1.9v4c0 3.2-2.1 5.5-5.2 6.9-3.1-1.4-5.2-3.7-5.2-6.9v-4L8 1.6z"/><rect x="6.2" y="7" width="3.6" height="2.8" rx=".7"/><path d="M7 7V5.9a1 1 0 0 1 2 0V7"/></svg>E2E-encrypted collab</h3>
      <p>Guests manage sessions and stop running turns remotely — encrypted end to
         end, nothing touches a third-party server.</p>
    </div>
  </div>
</section>

<section class="mp-section mp-reveal" id="download">
  <h2>Download</h2>
  <p class="mp-section-desc">Three ways to run MusePi — pick the surface that fits. Desktop builds are
  tagged releases with in-app auto-update; the TUI installs from one line; Android pairs with
  your desktop daemon over LAN.</p>
  <div class="mp-dl-grid">
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div>
      <h3>Desktop client</h3>
      <p class="mp-dl-sub">Electron GUI · liquid-glass surfaces · auto-update</p>
      <ul class="mp-dl-list">
        <li><a data-asset="arm64.dmg" href="https://github.com/MuseLinn/MusePi/releases/latest">macOS (Apple Silicon)</a><span class="mp-dl-fmt">.dmg</span></li>
        <li><a data-asset="setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 10/11 (x64)</a><span class="mp-dl-fmt">setup.exe</span></li>
        <li><a data-asset="arm64-setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 11 (ARM64)</a><span class="mp-dl-fmt">arm64-setup.exe</span></li>
        <li><a data-asset="x86_64.AppImage" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64</a><span class="mp-dl-fmt">.AppImage · .deb</span></li>
      </ul>
    </div>
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.4"/><path d="M10.5 18.5h3"/></svg></div>
      <h3>Android companion</h3>
      <p class="mp-dl-sub">Capacitor app · LAN pairing · remote control</p>
      <ul class="mp-dl-list">
        <li><a data-asset="app-debug.apk" href="https://github.com/MuseLinn/MusePi/releases/latest">Android arm64</a><span class="mp-dl-fmt">.apk</span></li>
        <li><a href="https://github.com/MuseLinn/MusePi/tree/main/packages/mobile">Build from source (Capacitor)</a><span class="mp-dl-fmt">packages/mobile</span></li>
      </ul>
    </div>
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M6.5 9.5l3.5 3-3.5 3M12.5 15.5H17"/></svg></div>
      <h3>Terminal TUI</h3>
      <p class="mp-dl-sub">The full agent surface in your terminal</p>
      <div class="mp-hero-code mp-hero-code--tight">
<pre><span class="mp-cmd">curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh</span>   <span class="mp-c"># macOS / Linux / WSL</span>
<span class="mp-cmd">git clone https://github.com/MuseLinn/MusePi.git &amp;&amp; cd MusePi</span>
<span class="mp-cmd">bun run setup &amp;&amp; bun run musepi</span>   <span class="mp-c"># Windows · from source</span></pre>
      </div>
      <p class="mp-dl-sub">Requires Node ≥ 22 or Bun. Same sessions, same daemon,
      same settings as the desktop app.</p>
    </div>
  </div>
  <p class="mp-dl-note">Every release ships an <code>update-manifest.json</code> for in-app
  auto-update; beta-channel builds publish as
  <a href="https://github.com/MuseLinn/MusePi/releases">pre-releases</a>.</p>
</section>

<section class="mp-section mp-quick mp-reveal" id="quick-start">
  <div class="mp-quick-copy">
    <p class="mp-demo-kicker">From source</p>
    <h2>Up and running in three commands</h2>
    <p>The full guide lives in README.md — daemon architecture, provider setup,
       mobile build and collab sharing.</p>
    <a class="mp-arrow-link" href="https://github.com/MuseLinn/MusePi/blob/main/README.md">Read README.md
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" fill="none"><path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </a>
  </div>
  <div class="mp-quick-code">
<pre><span class="mp-cmd">git clone https://github.com/MuseLinn/MusePi.git &amp;&amp; cd MusePi</span>
<span class="mp-cmd">bun run setup</span>                  <span class="mp-c"># install + natives + link</span>
<span class="mp-cmd">bun run musepi</span>                 <span class="mp-c"># terminal TUI</span>
<span class="mp-cmd">bun run --cwd=packages/desktop-app desktop</span>   <span class="mp-c"># desktop GUI</span></pre>
  </div>
</section>

<section class="mp-section mp-reveal" id="docs">
  <h2>Documentation</h2>
  <p class="mp-section-desc">Every doc lives in the repository — each card opens the latest revision on GitHub, so what you read is always current.</p>
  <div class="mp-docs-grid">
    <a class="mp-doc-card" href="https://github.com/MuseLinn/MusePi/blob/main/docs/gui-design.md">
      <span class="mp-doc-title">GUI design spec</span>
      <span class="mp-doc-desc">Layout · tokens · motion · components</span>
    </a>
    <a class="mp-doc-card" href="https://github.com/MuseLinn/MusePi/blob/main/docs/gui-implementation.md">
      <span class="mp-doc-title">GUI implementation</span>
      <span class="mp-doc-desc">Daemon RPC shapes · pitfalls · verification</span>
    </a>
    <a class="mp-doc-card" href="https://github.com/MuseLinn/MusePi/blob/main/docs/mobile-design.md">
      <span class="mp-doc-title">Mobile design spec</span>
      <span class="mp-doc-desc">Screens · motion · native chrome</span>
    </a>
    <a class="mp-doc-card" href="https://github.com/MuseLinn/MusePi/blob/main/docs/extensions-dev.md">
      <span class="mp-doc-title">Extension development</span>
      <span class="mp-doc-desc">Slots · HMR · API</span>
    </a>
    <a class="mp-doc-card" href="https://github.com/MuseLinn/MusePi/blob/main/packages/coding-agent/CHANGELOG.musepi.md">
      <span class="mp-doc-title">Changelog &amp; release notes</span>
      <span class="mp-doc-desc">What's new in every release, bilingual</span>
    </a>
    <a class="mp-doc-card" href="https://github.com/MuseLinn/MusePi/blob/main/UPSTREAM.md">
      <span class="mp-doc-title">Upstream sync tracking</span>
      <span class="mp-doc-desc">oh-my-pi upstream · merge policy</span>
    </a>
  </div>
</section>
