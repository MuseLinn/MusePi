---
layout: default
title: MusePi — 桌面优先的 AI 编程助手
lang: zh-CN
en_url: /
mp_cta: true
---

<section class="mp-hero">
  <div class="mp-hero-grid">
    <div class="mp-hero-copy">
      <p class="mp-kicker">桌面优先的 AI 编程助手</p>
      <h1 class="mp-hero-title">MusePi</h1>
      <p class="mp-hero-sub">
        Electron 桌面 GUI、常驻桌宠、Android 移动伴侣与 daemon 服务，构建于
        oh-my-pi agent 引擎之上。中文优先、磨砂玻璃、键盘驱动。
      </p>
      <div class="mp-cta-row">
        <a class="mp-cta mp-cta--primary" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="arm64.dmg">下载 macOS</a>
        <a class="mp-cta mp-cta--soft" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="setup.exe">下载 Windows</a>
        <a class="mp-cta mp-cta--soft" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="x86_64.AppImage">下载 Linux</a>
        <a class="mp-cta mp-cta--soft" href="{{ '/docs/' | relative_url }}">阅读文档</a>
      </div>
      <div class="mp-version">
        <span class="mp-pulse" aria-hidden="true"></span>
        <span class="mp-version-tag" data-release-version>v0.4.16</span>
        <span class="mp-version-meta">macOS · Windows · Linux · Android · HarmonyOS</span>
      </div>
    </div>
    <aside class="mp-term" aria-label="安装命令">
      <div class="mp-term-bar">
        <span class="mp-term-lights" aria-hidden="true"><i></i><i></i><i></i></span>
        <div class="mp-term-tabs" role="tablist">
          <button class="mp-term-tab" type="button" data-term-tab aria-selected="true">macOS · Linux</button>
          <button class="mp-term-tab" type="button" data-term-tab aria-selected="false">Windows</button>
          <button class="mp-term-tab" type="button" data-term-tab aria-selected="false">从源码</button>
        </div>
        <button class="mp-term-copy" type="button" data-term-copy data-copy="">复制</button>
      </div>
      <pre data-term-pane data-copy="curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh"><span class="mp-term-prompt">$ </span>curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh</pre>
      <pre data-term-pane data-copy="irm https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.ps1 | iex"><span class="mp-term-prompt">$ </span>irm https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.ps1 | iex</pre>
      <pre data-term-pane data-copy="git clone https://github.com/MuseLinn/MusePi.git && cd MusePi && bun run setup && bun run musepi"><span class="mp-term-prompt">$ </span>git clone https://github.com/MuseLinn/MusePi.git
<span class="mp-term-prompt">$ </span>cd MusePi &amp;&amp; bun run setup &amp;&amp; bun run musepi</pre>
    </aside>
  </div>
</section>

<section class="mp-statement mp-reveal">
  <h2>一个引擎，所有终端面。</h2>
  <p>按场景选择终端面——每一个都连着同一个 daemon、同一批会话、同一套设置。</p>
  <div class="mp-surfaces">
    <div class="mp-surface">
      <div class="mp-surface-visual mp-surface-visual--gui" aria-hidden="true">
        <span class="mp-win-dots"><i></i><i></i><i></i></span>
        <span class="mp-win-title">MusePi</span>
      </div>
      <h3>桌面客户端</h3>
      <p>完整驾驶舱——磨砂玻璃 GUI、会话树画布、悬浮状态卡与常驻桌宠。</p>
    </div>
    <div class="mp-surface">
      <div class="mp-surface-visual mp-surface-visual--tui" aria-hidden="true">
        <span class="mp-tui-line"><span class="mp-term-prompt">$ </span>musepi</span>
        <span class="mp-tui-cursor"></span>
      </div>
      <h3>终端 TUI</h3>
      <p>同一个 Agent 落进终端——键盘优先、SSH 友好，会话与设置完全一致。</p>
    </div>
    <div class="mp-surface">
      <div class="mp-surface-visual mp-surface-visual--phone" aria-hidden="true">
        <span class="mp-phone"><i class="mp-phone-bubble"></i><i class="mp-phone-bubble mp-phone-bubble--me"></i></span>
      </div>
      <h3>移动伴侣</h3>
      <p>Android 应用经 LAN 扫码配对——远程查看运行、发送提示、中止回合。</p>
    </div>
  </div>
</section>

<section class="mp-features" id="features">
  <article class="mp-feature mp-reveal">
    <div class="mp-feature-copy">
      <p class="mp-feature-kicker">桌面 GUI</p>
      <h3>给 Agent 一座磨砂玻璃驾驶舱</h3>
      <p>三栏布局落在真实的磨砂玻璃窗体材质上（Win11 acrylic / macOS
         vibrancy），会话与会话树画布都是一等公民。</p>
      <ul class="mp-feature-points">
        <li>所有 TUI 设置合并进一个可搜索面板</li>
        <li>悬浮状态卡实时呈现运行中的任务</li>
        <li>全程键盘驱动，中文优先排版</li>
      </ul>
    </div>
    <figure class="mp-feature-media">
      <img src="{{ '/docs/screenshots/gui-welcome.png' | relative_url }}" alt="MusePi 欢迎页" loading="lazy">
      <figcaption>欢迎页——点阵品牌背景、随时间变化的问候</figcaption>
    </figure>
  </article>

  <article class="mp-feature mp-feature--flip mp-reveal">
    <div class="mp-feature-copy">
      <p class="mp-feature-kicker">会话即树</p>
      <h3>每一次回答都长在树上</h3>
      <p>每条消息都携带父节点——历史是一棵可以行走的树，而不是只能重放的日志。</p>
      <ul class="mp-feature-points">
        <li>从任意节点分支、分叉、回退、重答</li>
        <li>画布地图绘制完整会话 DAG</li>
        <li>Trajectory 面板把同一棵树投影为时间线</li>
      </ul>
    </div>
    <figure class="mp-feature-media">
      <img src="{{ '/docs/screenshots/gui-session.png' | relative_url }}" alt="MusePi 会话视图" loading="lazy">
      <figcaption>会话——transcript、上下文环、悬浮状态卡</figcaption>
    </figure>
  </article>

  <article class="mp-feature mp-reveal">
    <div class="mp-feature-copy">
      <p class="mp-feature-kicker">Agent 引擎与扩展</p>
      <h3>一台可以边跑边改装的引擎</h3>
      <p>一切皆可插拔：模型提供商、工具、UI 表面——daemon 盯着你的扩展目录，
         改动即热生效。</p>
      <ul class="mp-feature-points">
        <li>40+ LLM 提供商，内置图像与视频生成</li>
        <li>浏览器 + computer-use 工具、LSP/DAP、任务子代理</li>
        <li>双扩展中心：slot 组件、工具视图、RPC、主题</li>
      </ul>
    </div>
    <figure class="mp-feature-media">
      <img src="{{ '/docs/screenshots/gui-settings.png' | relative_url }}" alt="MusePi 设置面板" loading="lazy">
      <figcaption>设置——所有 TUI 设置，可搜索、可分组</figcaption>
    </figure>
  </article>

  <div class="mp-grid mp-reveal">
    <div class="mp-card">
      <h3><span class="mp-dot"></span>常驻桌宠</h3>
      <p>可拖拽定位、点击穿透、悬停互动与任务气泡的动画伴侣——Agent
         状态一眼可见。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>远程与移动</h3>
      <p>访客可远程管理会话、中止运行中的回合（端到端加密协作）；Android
         伴侣扫码经 LAN 配对，三合一发送栏。</p>
    </div>
  </div>
</section>

<section class="mp-section mp-reveal" id="download">
  <h2>下载</h2>
  <p class="mp-section-desc">三种运行方式，按需选择。桌面构建为 tag 发布、应用内自动更新；TUI
  来自 npm；Android 通过 LAN 与桌面 daemon 配对。</p>
  <div class="mp-dl-grid">
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true">🖥️</div>
      <h3>桌面客户端</h3>
      <p class="mp-dl-sub">Electron GUI · 磨砂玻璃窗体 · 自动更新</p>
      <ul class="mp-dl-list">
        <li><a data-asset="arm64.dmg" href="https://github.com/MuseLinn/MusePi/releases/latest">macOS（Apple Silicon）— .dmg</a></li>
        <li><a data-asset="setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 10/11 — setup.exe</a></li>
        <li><a data-asset="x86_64.AppImage" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64 — .AppImage</a></li>
        <li><a data-asset="amd64.deb" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64 — .deb</a></li>
      </ul>
    </div>
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true">📱</div>
      <h3>Android 伴侣</h3>
      <p class="mp-dl-sub">Capacitor 应用 · LAN 配对 · 远程控制</p>
      <ul class="mp-dl-list">
        <li><a data-asset="app-debug.apk" href="https://github.com/MuseLinn/MusePi/releases/latest">Android arm64 — .apk</a></li>
        <li><a href="https://github.com/MuseLinn/MusePi/tree/main/packages/mobile">从源码构建（Capacitor）</a></li>
      </ul>
    </div>
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true">⌨️</div>
      <h3>终端 TUI</h3>
      <p class="mp-dl-sub">完整的 Agent 终端界面</p>
      <div class="mp-hero-code mp-hero-code--tight">
<pre><span class="mp-cmd">curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh</span>   <span class="mp-c"># macOS / Linux / WSL</span>
<span class="mp-cmd">git clone https://github.com/MuseLinn/MusePi.git &amp;&amp; cd MusePi</span>
<span class="mp-cmd">bun run setup &amp;&amp; bun run musepi</span>   <span class="mp-c"># Windows · 从源码</span></pre>
      </div>
      <p class="mp-dl-sub">需要 Node ≥ 22 或 Bun。与会话、daemon、设置完全互通。</p>
    </div>
  </div>
  <p class="mp-dl-note">每个 release 都附带 <code>update-manifest.json</code>
  供应用内自动更新；beta 渠道构建以
  <a href="https://github.com/MuseLinn/MusePi/releases">pre-release</a> 发布。</p>
</section>

<section class="mp-section mp-reveal" id="quick-start">
  <h2>快速开始（从源码）</h2>
  <div class="mp-quick">
<pre><span class="mp-cmd">git clone https://github.com/MuseLinn/MusePi.git &amp;&amp; cd MusePi</span>
<span class="mp-cmd">bun run setup</span>                  <span class="mp-c"># 安装 + natives + link</span>
<span class="mp-cmd">bun run musepi</span>                 <span class="mp-c"># 终端 TUI</span>
<span class="mp-cmd">bun run --cwd=packages/gui desktop</span>   <span class="mp-c"># 桌面 GUI</span></pre>
  </div>
  <p class="mp-note">完整指南见 <a href="{{ 'README.zh-CN.md' | relative_url }}">README.zh-CN.md</a>——daemon
  架构、提供商配置、移动端构建、协作共享。</p>
</section>

<section class="mp-section mp-reveal">
  <h2>文档</h2>
  <ul class="mp-docs">
    <li><a href="{{ 'docs/gui-design.md' | relative_url }}">GUI 设计规范 — 布局 / 令牌 / 动效 / 组件</a></li>
    <li><a href="{{ 'docs/gui-implementation.md' | relative_url }}">GUI 实现 — daemon RPC 契约、坑位、验证</a></li>
    <li><a href="{{ 'docs/mobile-design.md' | relative_url }}">移动端设计规范 — 屏幕 / 动效 / 原生框架</a></li>
    <li><a href="{{ 'docs/plugin-design.md' | relative_url }}">插件化设计 — MusePi 插件化（pi ↔ dsh 接缝映射）</a></li>
    <li><a href="{{ 'docs/extensions-dev.md' | relative_url }}">扩展开发 — 槽位 / HMR / API</a></li>
    <li><a href="{{ 'docs/board-dashboard.md' | relative_url }}">看板与组件设计系统</a></li>
    <li><a href="{{ 'UPSTREAM.md' | relative_url }}">上游同步追踪</a></li>
  </ul>
</section>
