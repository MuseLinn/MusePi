---
layout: default
title: MusePi — a desktop-first AI coding agent
lang: en
zh_url: /MusePi/index.zh-CN.html
---

<section class="mp-hero">
  <div class="mp-hero-grid">
    <div class="mp-hero-copy">
      <p class="mp-kicker">Desktop-first AI coding agent</p>
      <h1>MusePi</h1>
      <p class="mp-tagline">
        An Electron desktop GUI, an always-on desktop pet, a mobile companion and a
        daemon service on top of the oh-my-pi agent engine. Chinese-first,
        frosted-glass, keyboard-driven.
      </p>
      <div class="mp-cta-row">
        <a class="mp-cta" href="https://github.com/MuseLinn/MusePi/releases/latest" data-latest-release>Download for desktop</a>
        <a class="mp-cta mp-cta-ghost" href="{{ '/docs/' | relative_url }}">Read the docs</a>
      </div>
      <div class="mp-version">
        <span class="mp-pulse" aria-hidden="true"></span>
        <span class="mp-version-tag" data-release-version>v0.4.6</span>
        <span class="mp-version-meta">macOS · Windows · Linux · Android · HarmonyOS</span>
      </div>
    </div>
    <div class="mp-hero-mark" aria-hidden="true">
      <canvas class="mp-dots"></canvas>
      <p class="mp-hero-mark-note">π — the dot-matrix brand mark, drawn live</p>
    </div>
  </div>
  <div class="mp-hero-code">
<pre><span class="mp-cmd">npm i -g @musepi/pi-coding-agent</span>   <span class="mp-c"># terminal TUI → musepi</span>
<span class="mp-cmd">bun run setup &amp;&amp; bun run musepi</span>    <span class="mp-c"># from source</span></pre>
  </div>
</section>

<section class="mp-section mp-reveal" id="download">
  <h2>Download</h2>
  <p class="mp-section-desc">Three ways to run MusePi — pick the surface that fits. Desktop builds are
  tagged releases with in-app auto-update; the TUI installs from npm; Android pairs with
  your desktop daemon over LAN.</p>
  <div class="mp-dl-grid">
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true">🖥️</div>
      <h3>Desktop client</h3>
      <p class="mp-dl-sub">Electron GUI · frosted-glass window · auto-update</p>
      <ul class="mp-dl-list">
        <li><a data-asset="MusePi-{v}-arm64.dmg" href="https://github.com/MuseLinn/MusePi/releases/latest">macOS (Apple Silicon) — .dmg</a></li>
        <li><a data-asset="MusePi-{v}-setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 10/11 — setup.exe</a></li>
        <li><a data-asset="MusePi-{v}-x86_64.AppImage" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64 — .AppImage / .deb</a></li>
      </ul>
    </div>
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true">📱</div>
      <h3>Android companion</h3>
      <p class="mp-dl-sub">Capacitor app · LAN pairing · remote control</p>
      <ul class="mp-dl-list">
        <li><a data-asset="app-debug.apk" href="https://github.com/MuseLinn/MusePi/releases/latest">Android arm64 — .apk</a></li>
        <li><a href="https://github.com/MuseLinn/MusePi/tree/main/packages/mobile">Build from source (Capacitor)</a></li>
      </ul>
    </div>
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true">⌨️</div>
      <h3>Terminal TUI</h3>
      <p class="mp-dl-sub">The full agent surface in your terminal</p>
      <div class="mp-hero-code mp-hero-code--tight">
<pre><span class="mp-cmd">npm i -g @musepi/pi-coding-agent</span>
<span class="mp-cmd">musepi</span></pre>
      </div>
      <p class="mp-dl-sub">Requires Node ≥ 22 or Bun. Same sessions, same daemon,
      same settings as the desktop app.</p>
    </div>
  </div>
  <p class="mp-dl-note">Every release ships an <code>update-manifest.json</code> for in-app
  auto-update; beta-channel builds publish as
  <a href="https://github.com/MuseLinn/MusePi/releases">pre-releases</a>.</p>
</section>

<section class="mp-section mp-reveal" id="features">
  <h2>What makes MusePi different</h2>
  <div class="mp-grid">
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Desktop GUI</h3>
      <p>Three-pane layout, real frosted-glass window material (Win11 acrylic / macOS
         vibrancy), chat ↔ session-tree-map surfaces, floating status cards, and every
         TUI setting merged into a searchable panel.</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Sessions as a tree</h3>
      <p>Every message carries its parent — branch, fork, revert and re-answer from any
         node. The canvas map draws the whole conversation DAG; the trajectory panel
         projects the same tree as a timeline.</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Agent engine</h3>
      <p>40+ LLM providers, built-in image generation (multi-provider with automatic
         fallback) and video generation, browser + computer-use tools, LSP/DAP, task
         subagents, ACP, magic keywords.</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Extension ecosystem</h3>
      <p>Two extension centers (OMP Extension Packages + MusePi Extensions): slot
         components, tool views, RPCs, skills, themes, motion packs — hot-reloaded
         while the daemon watches your extension folders.</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Always-on pet</h3>
      <p>An animated companion with drag positioning, click-through, hover interactions
         and task bubbles — the agent's status at a glance.</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Remote &amp; mobile</h3>
      <p>Guests manage sessions and stop running turns remotely (E2E-encrypted collab);
         the Android companion pairs over LAN with QR join and a three-in-one send bar.</p>
    </div>
  </div>
</section>

<section class="mp-section mp-reveal" id="screens">
  <h2>Screens</h2>
  <div class="mp-shots">
    <figure class="mp-shot">
      <img src="{{ '/docs/screenshots/gui-welcome.png' | relative_url }}" alt="Welcome" loading="lazy">
      <figcaption>Welcome — dot-matrix brand backdrop, time-aware greeting</figcaption>
    </figure>
    <figure class="mp-shot">
      <img src="{{ '/docs/screenshots/gui-session.png' | relative_url }}" alt="Session" loading="lazy">
      <figcaption>Session — transcript, context donut, floating status cards</figcaption>
    </figure>
    <figure class="mp-shot">
      <img src="{{ '/docs/screenshots/gui-settings.png' | relative_url }}" alt="Settings" loading="lazy">
      <figcaption>Settings — every TUI setting, searchable and grouped</figcaption>
    </figure>
  </div>
</section>

<section class="mp-section mp-reveal" id="quick-start">
  <h2>Quick start (from source)</h2>
  <div class="mp-quick">
<pre><span class="mp-cmd">git clone https://github.com/MuseLinn/MusePi.git &amp;&amp; cd MusePi</span>
<span class="mp-cmd">bun run setup</span>                  <span class="mp-c"># install + natives + link</span>
<span class="mp-cmd">bun run musepi</span>                 <span class="mp-c"># terminal TUI</span>
<span class="mp-cmd">bun --cwd=packages/gui run desktop</span>   <span class="mp-c"># desktop GUI</span></pre>
  </div>
  <p class="mp-note">The full guide lives in <a href="{{ 'README.md' | relative_url }}">README.md</a> —
  daemon architecture, provider setup, mobile build, collab sharing.</p>
</section>

<section class="mp-section mp-reveal">
  <h2>Documentation</h2>
  <ul class="mp-docs">
    <li><a href="{{ 'docs/gui-design.md' | relative_url }}">GUI design spec — layout / tokens / motion / components</a></li>
    <li><a href="{{ 'docs/gui-implementation.md' | relative_url }}">GUI implementation — daemon RPC shapes, pitfalls, verification</a></li>
    <li><a href="{{ 'docs/mobile-design.md' | relative_url }}">Mobile design spec — screens / motion / native chrome</a></li>
    <li><a href="{{ 'docs/plugin-design.md' | relative_url }}">Plugin design — MusePi 插件化 (pi ↔ dsh seam mapping)</a></li>
    <li><a href="{{ 'docs/extensions-dev.md' | relative_url }}">Extension development — slots / HMR / API</a></li>
    <li><a href="{{ 'docs/board-dashboard.md' | relative_url }}">Board dashboard &amp; widget design system</a></li>
    <li><a href="{{ 'UPSTREAM.md' | relative_url }}">Upstream sync tracking</a></li>
  </ul>
</section>
