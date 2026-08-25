---
layout: default
title: MusePi
---

<section class="mp-hero">
  <h1>MusePi</h1>
  <p class="mp-tagline">
    A desktop-first AI coding agent — an Electron GUI, an always-on desktop pet, a
    mobile companion and a daemon service on top of the oh-my-pi agent engine.
    Chinese-first, frosted-glass, keyboard-driven.
  </p>
  <p class="mp-lang">English | [中文](index.zh-CN.md)</p>
  <div class="mp-cta-row">
    <a class="mp-cta" href="https://github.com/MuseLinn/MusePi/releases">Download v0.4.4 →</a>
    <a class="mp-cta mp-cta-ghost" href="{{ '/docs/' | relative_url }}">Read the docs</a>
  </div>
  <div class="mp-version">
    <span class="mp-pulse" aria-hidden="true"></span>
    <span class="mp-version-tag">v0.4.4</span>
    <span class="mp-version-meta">macOS · Windows · Linux · Android · HarmonyOS</span>
  </div>
  <div class="mp-hero-code">
    <span class="mp-cmd">bun run setup</span><br>
    <span class="mp-cmd">bun run musepi</span>                <span style="opacity:.5"># terminal TUI</span><br>
    <span class="mp-cmd">bun --cwd=packages/gui run desktop</span>  <span style="opacity:.5"># desktop GUI</span>
  </div>
</section>

<section class="mp-section mp-reveal" id="features">
  <h2>What makes MusePi different</h2>
  <div class="mp-grid">
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Desktop GUI</h3>
      <p>Three-pane layout, frosted-glass vibrancy window, three-axis design tokens
         (theme / accent / density), full TUI command surface wired in.</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Always-on pet</h3>
      <p>An animated companion (petdex frame packs) with drag positioning, click-through,
         hover interactions and task bubbles — the agent's status at a glance.</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Daemon architecture</h3>
      <p>JSON-RPC over WebSocket. Sessions persist via journal + materialized view,
         idle sessions snapshot to history, the daemon survives GUI exit.</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Settings, all of them</h3>
      <p>All 336 TUI settings merged into the desktop panel (schema-driven, same source
         of truth), searchable down to individual setting rows.</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Agent engine</h3>
      <p>40+ LLM providers, 32 built-in tools, LSP/DAP wiring, task subagents, hashline,
         hindsight, ACP, collab sharing.</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Board &amp; widgets</h3>
      <p>Live kanban with window-adaptive canvas and a ChromaGrid-style group glow;
         custom HTML widgets with theme hot-swap.</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Mobile companion</h3>
      <p>Capacitor Android app pairing with your desktop daemon over LAN — QR join,
         session archiving, three-in-one send with dot-matrix bloom, braille working
         indicator. PWA offline shell + HarmonyOS WebView shell.</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Remote &amp; branching</h3>
      <p>Guests manage sessions and stop running turns remotely (E2E-encrypted collab).
         撤回 = branchAt tree jumps with an animated undo dock; /btw promotes into a
         branched session; plan approve-and-compact keeps context lean.</p>
    </div>
  </div>
</section>

<section class="mp-section mp-reveal" id="screens">
  <h2>Screens</h2>
  <div class="mp-shots">
    <figure class="mp-shot">
      <img src="{{ '/assets/../docs/screenshots/gui-welcome.png' | relative_url }}" alt="Welcome">
      <figcaption>Welcome — dot-matrix brand backdrop</figcaption>
    </figure>
    <figure class="mp-shot">
      <img src="{{ '/assets/../docs/screenshots/gui-session.png' | relative_url }}" alt="Session">
      <figcaption>Session — bash cards, transcripts, context donut</figcaption>
    </figure>
    <figure class="mp-shot">
      <img src="{{ '/assets/../docs/screenshots/gui-settings.png' | relative_url }}" alt="Settings">
      <figcaption>Settings — 336 TUI settings, searchable</figcaption>
    </figure>
  </div>
</section>

<section class="mp-section mp-reveal" id="quick-start">
  <h2>Quick start</h2>
  <div class="mp-quick">
<pre><span class="mp-cmd">bun run setup</span>                  # install + natives + link
<span class="mp-cmd">bun run musepi</span>                 # terminal TUI
<span class="mp-cmd">bun --cwd=packages/coding-agent src/cli.ts serve --port 8300</span>   # daemon
<span class="mp-cmd">bun --cwd=packages/gui run desktop</span>        # desktop GUI</pre>
  </div>
  <p style="color:var(--text-muted);font-size:14px">The full guide lives in <a href="{{ 'README.md' | relative_url }}">README.md</a>.</p>
</section>

<section class="mp-section mp-reveal">
  <h2>Documentation</h2>
  <ul class="mp-docs">
    <li><a href="{{ 'docs/gui-design.md' | relative_url }}">GUI design spec — layout / tokens / motion / components</a></li>
    <li><a href="{{ 'docs/mobile-design.md' | relative_url }}">Mobile design spec — screens / motion / native chrome</a></li>
    <li><a href="{{ 'docs/gui-implementation.md' | relative_url }}">GUI implementation — daemon RPC shapes, pitfalls, verification</a></li>
    <li><a href="{{ 'docs/widget-design-system.md' | relative_url }}">Widget design system</a></li>
    <li><a href="{{ 'docs/board-dashboard.md' | relative_url }}">Board dashboard</a></li>
    <li><a href="{{ 'docs/collab.md' | relative_url }}">Collab sharing (LAN / tunnel / Tailscale extras)</a></li>
    <li><a href="{{ 'UPSTREAM.md' | relative_url }}">Upstream sync tracking</a></li>
  </ul>
</section>
