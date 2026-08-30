---
layout: default
title: MusePi — 桌面优先的 AI 编程助手
lang: zh-CN
en_url: /
---

<section class="mp-hero">
  <div class="mp-hero-grid">
    <div class="mp-hero-copy">
      <p class="mp-kicker">桌面优先的 AI 编程助手</p>
      <h1>MusePi</h1>
      <p class="mp-tagline">
        Electron 桌面 GUI、常驻桌宠、Android 移动伴侣与 daemon 服务，构建于
        oh-my-pi agent 引擎之上。中文优先、磨砂玻璃、键盘驱动。
      </p>
      <div class="mp-cta-row">
        <a class="mp-cta" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="arm64.dmg">下载 macOS</a>
        <a class="mp-cta" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="setup.exe">下载 Windows</a>
        <a class="mp-cta" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="x86_64.AppImage">下载 Linux</a>
        <a class="mp-cta mp-cta-ghost" href="{{ '/docs/' | relative_url }}">阅读文档</a>
      </div>
      <div class="mp-version">
        <span class="mp-pulse" aria-hidden="true"></span>
        <span class="mp-version-tag" data-release-version>v0.4.7</span>
        <span class="mp-version-meta">macOS · Windows · Linux · Android · HarmonyOS</span>
      </div>
    </div>
    <div class="mp-hero-mark" aria-hidden="true">
      <canvas class="mp-dots"></canvas>
      <p class="mp-hero-mark-note">π — 点阵品牌标记，页面实时绘制</p>
    </div>
  </div>
  <div class="mp-hero-code">
<pre><span class="mp-c"># macOS · Linux · WSL</span>
<span class="mp-cmd">curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh</span>
<span class="mp-c"># Windows · PowerShell</span>
<span class="mp-cmd">irm https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.ps1 | iex</span></pre>
  </div>
</section>

<section class="mp-section mp-reveal" id="download">
  <h2>下载</h2>
  <p class="mp-section-desc">三种运行形态，按场景选择：桌面客户端为正式 tag 发布（应用内自动更新）；
  TUI 来自 npm；Android 与桌面 daemon 局域网配对。</p>
  <div class="mp-dl-grid">
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true">🖥️</div>
      <h3>桌面客户端</h3>
      <p class="mp-dl-sub">Electron GUI · 磨砂玻璃窗口 · 自动更新</p>
      <ul class="mp-dl-list">
        <li><a data-asset="arm64.dmg" href="https://github.com/MuseLinn/MusePi/releases/latest">macOS (Apple Silicon) — .dmg</a></li>
        <li><a data-asset="setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 10/11 — setup.exe</a></li>
        <li><a data-asset="x86_64.AppImage" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64 — .AppImage</a></li>
        <li><a data-asset="amd64.deb" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64 — .deb</a></li>
      </ul>
    </div>
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true">📱</div>
      <h3>Android 移动伴侣</h3>
      <p class="mp-dl-sub">Capacitor 应用 · 局域网配对 · 远程控制</p>
      <ul class="mp-dl-list">
        <li><a data-asset="app-debug.apk" href="https://github.com/MuseLinn/MusePi/releases/latest">Android arm64 — .apk</a></li>
        <li><a href="https://github.com/MuseLinn/MusePi/tree/main/packages/mobile">从源码构建（Capacitor）</a></li>
      </ul>
    </div>
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true">⌨️</div>
      <h3>终端 TUI</h3>
      <p class="mp-dl-sub">完整的 agent 能力面，就在你的终端里</p>
      <div class="mp-hero-code mp-hero-code--tight">
<pre><span class="mp-cmd">curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh</span>   <span class="mp-c"># macOS / Linux / WSL</span>
<span class="mp-cmd">git clone https://github.com/MuseLinn/MusePi.git &amp;&amp; cd MusePi</span>
<span class="mp-cmd">bun run setup &amp;&amp; bun run musepi</span>   <span class="mp-c"># Windows · 从源码</span></pre>
      </div>
      <p class="mp-dl-sub">需要 Node ≥ 22 或 Bun。与桌面端共享会话、daemon 与设置。</p>
    </div>
  </div>
  <p class="mp-dl-note">每个 release 都附带 <code>update-manifest.json</code> 供应用内自动更新；
  beta 渠道构建以 <a href="https://github.com/MuseLinn/MusePi/releases">预发布</a> 形式发布。</p>
</section>

<section class="mp-section mp-reveal" id="features">
  <h2>MusePi 的不同之处</h2>
  <div class="mp-grid">
    <div class="mp-card">
      <h3><span class="mp-dot"></span>桌面 GUI</h3>
      <p>三栏布局、真实磨砂玻璃窗口材质（Win11 acrylic / macOS vibrancy）、对话 ↔
         会话树地图双表面、右上浮动状态卡，全部 TUI 设置合并进可搜索的设置面板。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>会话即树</h3>
      <p>每条消息携带父节点——任意节点可分支、分叉、撤回、重答。画布地图绘制整棵对话
         DAG，轨迹面板把同一棵树投影成时间线。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Agent 引擎</h3>
      <p>40+ 模型供应商，内置生图（多 provider 自动回退）与生视频工具，浏览器 +
         computer-use 工具，LSP/DAP，任务子智能体，ACP，魔法关键词。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>扩展生态</h3>
      <p>双扩展中心（OMP Extension Packages + MusePi Extensions）：槽位组件、工具视图、
         RPC、技能、主题、动效包——daemon 监听扩展目录，改动热生效。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>常驻桌宠</h3>
      <p>可拖拽、可点击穿透的动画伴侣，悬停互动 + 任务气泡——agent 状态一眼可见。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>远程与移动</h3>
      <p>协作者可远程管理会话、终止运行中的回合（端到端加密）；Android 伴侣扫码经
         局域网配对，三合一发送栏随时追加输入。</p>
    </div>
  </div>
</section>

<section class="mp-section mp-reveal" id="screens">
  <h2>界面</h2>
  <div class="mp-shots">
    <figure class="mp-shot">
      <img src="{{ '/docs/screenshots/gui-welcome.png' | relative_url }}" alt="欢迎页" loading="lazy">
      <figcaption>欢迎页 — 点阵品牌背景、时段问候</figcaption>
    </figure>
    <figure class="mp-shot">
      <img src="{{ '/docs/screenshots/gui-session.png' | relative_url }}" alt="会话" loading="lazy">
      <figcaption>会话 — 转写、上下文环、浮动状态卡</figcaption>
    </figure>
    <figure class="mp-shot">
      <img src="{{ '/docs/screenshots/gui-settings.png' | relative_url }}" alt="设置" loading="lazy">
      <figcaption>设置 — 全部 TUI 设置，可搜索、分组呈现</figcaption>
    </figure>
  </div>
</section>

<section class="mp-section mp-reveal" id="quick-start">
  <h2>快速开始（源码）</h2>
  <div class="mp-quick">
<pre><span class="mp-cmd">git clone https://github.com/MuseLinn/MusePi.git &amp;&amp; cd MusePi</span>
<span class="mp-cmd">bun run setup</span>                  <span class="mp-c"># 安装 + 原生依赖 + 链接</span>
<span class="mp-cmd">bun run musepi</span>                 <span class="mp-c"># 终端 TUI</span>
<span class="mp-cmd">bun run --cwd=packages/gui desktop</span>   <span class="mp-c"># 桌面 GUI</span></pre>
  </div>
  <p class="mp-note">完整指南见 <a href="{{ 'README.zh-CN.md' | relative_url }}">README.zh-CN.md</a> —
  daemon 架构、供应商配置、移动端构建、协作共享。</p>
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
