---
layout: default
title: MusePi — a desktop-first AI coding agent
lang: en
zh_url: /index.zh-CN.html
mp_cta: true
---

<section class="mp-hero">
  <div class="mp-hero-grid">
    <div class="mp-hero-copy">
      <p class="mp-kicker">Desktop-first AI coding agent</p>
      <h1 class="mp-hero-title">MusePi</h1>
      <p class="mp-hero-sub">
        An Electron desktop GUI, an always-on desktop pet, a mobile companion and a
        daemon service on top of the oh-my-pi agent engine. Chinese-first,
        frosted-glass, keyboard-driven.
      </p>
      <div class="mp-cta-row">
        <a class="mp-cta mp-cta--primary" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="arm64.dmg">Download macOS</a>
        <a class="mp-cta mp-cta--soft" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="setup.exe">Download Windows</a>
        <a class="mp-cta mp-cta--soft" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="x86_64.AppImage">Download Linux</a>
        <a class="mp-cta mp-cta--soft" href="{{ '/docs/' | relative_url }}">Read the docs</a>
      </div>
      <div class="mp-version">
        <span class="mp-pulse" aria-hidden="true"></span>
        <span class="mp-version-tag" data-release-version>v0.4.16</span>
        <span class="mp-version-meta">macOS · Windows · Linux · Android · HarmonyOS</span>
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
    </aside>
  </div>
</section>

<section class="mp-statement mp-reveal">
  <h2>One engine. Every surface.</h2>
  <p>Pick the surface that fits the moment — every one of them talks to the same
     daemon, the same sessions, the same settings.</p>
  <div class="mp-surfaces">
    <div class="mp-surface">
      <div class="mp-surface-visual mp-surface-visual--gui" aria-hidden="true">
        <span class="mp-win-dots"><i></i><i></i><i></i></span>
        <span class="mp-win-title">MusePi</span>
      </div>
      <h3>Desktop client</h3>
      <p>The full cockpit — frosted-glass GUI, session-tree canvas, floating status
         cards and the always-on pet.</p>
    </div>
    <div class="mp-surface">
      <div class="mp-surface-visual mp-surface-visual--tui" aria-hidden="true">
        <span class="mp-tui-line"><span class="mp-term-prompt">$ </span>musepi</span>
        <span class="mp-tui-cursor"></span>
      </div>
      <h3>Terminal TUI</h3>
      <p>The same agent in your terminal — keyboard-first, SSH-friendly, identical
         sessions and settings.</p>
    </div>
    <div class="mp-surface">
      <div class="mp-surface-visual mp-surface-visual--phone" aria-hidden="true">
        <span class="mp-phone"><i class="mp-phone-bubble"></i><i class="mp-phone-bubble mp-phone-bubble--me"></i></span>
      </div>
      <h3>Mobile companion</h3>
      <p>An Android app that pairs over LAN with a QR join — watch runs, send prompts
         and stop turns from anywhere.</p>
    </div>
  </div>
</section>

<section class="mp-features" id="features">
  <article class="mp-feature mp-reveal">
    <div class="mp-feature-copy">
      <p class="mp-feature-kicker">Desktop GUI</p>
      <h3>A frosted-glass cockpit for your agent</h3>
      <p>Three-pane layout on a real frosted-glass window material (Win11 acrylic /
         macOS vibrancy), with chat and the session-tree-map as first-class surfaces.</p>
      <ul class="mp-feature-points">
        <li>Every TUI setting merged into one searchable panel</li>
        <li>Floating status cards for running tasks</li>
        <li>Keyboard-driven throughout, Chinese-first typography</li>
      </ul>
    </div>
    <figure class="mp-feature-media">
      <img src="{{ '/docs/screenshots/gui-welcome.png' | relative_url }}" alt="MusePi welcome screen" loading="lazy">
      <figcaption>Welcome — dot-matrix brand backdrop, time-aware greeting</figcaption>
    </figure>
  </article>

  <article class="mp-feature mp-feature--flip mp-reveal">
    <div class="mp-feature-copy">
      <p class="mp-feature-kicker">Sessions as a tree</p>
      <h3>Every answer grows on a tree</h3>
      <p>Every message carries its parent — so history is a tree you can walk, not a
         log you must replay.</p>
      <ul class="mp-feature-points">
        <li>Branch, fork, revert and re-answer from any node</li>
        <li>The canvas map draws the whole conversation DAG</li>
        <li>The trajectory panel projects the same tree as a timeline</li>
      </ul>
    </div>
    <figure class="mp-feature-media">
      <img src="{{ '/docs/screenshots/gui-session.png' | relative_url }}" alt="MusePi session view" loading="lazy">
      <figcaption>Session — transcript, context donut, floating status cards</figcaption>
    </figure>
  </article>

  <article class="mp-feature mp-reveal">
    <div class="mp-feature-copy">
      <p class="mp-feature-kicker">Agent engine &amp; extensions</p>
      <h3>An engine you can rebuild mid-flight</h3>
      <p>Everything is pluggable: model providers, tools, UI surfaces — hot-reloaded
         while the daemon watches your extension folders.</p>
      <ul class="mp-feature-points">
        <li>40+ LLM providers, image &amp; video generation built in</li>
        <li>Browser + computer-use tools, LSP/DAP, task subagents</li>
        <li>Two extension centers with slots, tool views, RPCs, themes</li>
      </ul>
    </div>
    <figure class="mp-feature-media">
      <img src="{{ '/docs/screenshots/gui-settings.png' | relative_url }}" alt="MusePi settings panel" loading="lazy">
      <figcaption>Settings — every TUI setting, searchable and grouped</figcaption>
    </figure>
  </article>

  <div class="mp-grid mp-reveal">
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
        <li><a data-asset="arm64.dmg" href="https://github.com/MuseLinn/MusePi/releases/latest">macOS (Apple Silicon) — .dmg</a></li>
        <li><a data-asset="setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 10/11 — setup.exe</a></li>
        <li><a data-asset="x86_64.AppImage" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64 — .AppImage</a></li>
        <li><a data-asset="amd64.deb" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64 — .deb</a></li>
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

<section class="mp-section mp-reveal" id="quick-start">
  <h2>Quick start (from source)</h2>
  <div class="mp-quick">
<pre><span class="mp-cmd">git clone https://github.com/MuseLinn/MusePi.git &amp;&amp; cd MusePi</span>
<span class="mp-cmd">bun run setup</span>                  <span class="mp-c"># install + natives + link</span>
<span class="mp-cmd">bun run musepi</span>                 <span class="mp-c"># terminal TUI</span>
<span class="mp-cmd">bun run --cwd=packages/gui desktop</span>   <span class="mp-c"># desktop GUI</span></pre>
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
