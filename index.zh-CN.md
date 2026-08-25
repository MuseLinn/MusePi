---
layout: default
title: MusePi
lang: zh-CN
---

<section class="mp-hero">
  <h1>MusePi</h1>
  <p class="mp-tagline">
    桌面优先的 AI 编程助手——Electron 桌面 GUI、常驻桌宠、移动端伴侣与 daemon 服务，
    构建于 oh-my-pi agent 引擎之上。中文优先、磨砂玻璃、键盘驱动。
  </p>
  <p class="mp-lang">[English](index.md) | 中文</p>
  <div class="mp-cta-row">
    <a class="mp-cta" href="https://github.com/MuseLinn/MusePi/releases">下载 v0.4.4 →</a>
    <a class="mp-cta mp-cta-ghost" href="{{ '/docs/' | relative_url }}">阅读文档</a>
  </div>
  <div class="mp-version">
    <span class="mp-pulse" aria-hidden="true"></span>
    <span class="mp-version-tag">v0.4.4</span>
    <span class="mp-version-meta">macOS · Windows · Linux · Android · HarmonyOS</span>
  </div>
  <div class="mp-hero-code">
    <span class="mp-cmd">bun run setup</span><br>
    <span class="mp-cmd">bun run musepi</span>                <span style="opacity:.5"># 终端 TUI</span><br>
    <span class="mp-cmd">bun --cwd=packages/gui run desktop</span>  <span style="opacity:.5"># 桌面 GUI</span>
  </div>
</section>

<section class="mp-section mp-reveal" id="features">
  <h2>MusePi 的不同之处</h2>
  <div class="mp-grid">
    <div class="mp-card">
      <h3><span class="mp-dot"></span>桌面 GUI</h3>
      <p>三栏布局、磨砂玻璃 vibrancy 窗口、三轴设计 token（主题 / 强调色 / 密度），
        完整 TUI 命令面全部接入。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>常驻桌宠</h3>
      <p>动画伙伴（petdex 帧包），支持拖拽定位、点击穿透、悬停交互与任务气泡——
        一眼看清 agent 状态。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Daemon 架构</h3>
      <p>WebSocket 上的 JSON-RPC。会话经 journal + materialized view 持久化，
        空闲会话快照为历史，daemon 在 GUI 退出后继续存活。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>全部设置</h3>
      <p>TUI 的 336 项设置全部并入桌面面板（schema 驱动、同一事实源），
        可搜索到单个设置行。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>Agent 引擎</h3>
      <p>40+ LLM 供应商、32 个内置工具、LSP/DAP 接线、任务子智能体、hashline、
        hindsight、ACP、collab 共享。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>看板与组件</h3>
      <p>实时看板，窗口自适应画布 + ChromaGrid 式组辉光；自定义 HTML 组件支持主题热切换。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>移动端伴侣</h3>
      <p>Capacitor Android 应用经局域网配对桌面 daemon——QR 加入、会话归档、
        点阵绽放三合一发送、盲文工作指示。PWA 离线壳 + HarmonyOS WebView 壳。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>远程与分支</h3>
      <p>访客远程管理会话、中止运行中的回合（E2E 加密 collab）。撤回 = branchAt 树跳转
        带动画撤销坞；/btw 晋升为分支会话；plan 批准即压缩保持上下文精简。</p>
    </div>
  </div>
</section>

<section class="mp-section mp-reveal" id="screens">
  <h2>界面</h2>
  <div class="mp-shots">
    <figure class="mp-shot">
      <img src="{{ '/assets/../docs/screenshots/gui-welcome.png' | relative_url }}" alt="欢迎页">
      <figcaption>欢迎页——点阵品牌背景</figcaption>
    </figure>
    <figure class="mp-shot">
      <img src="{{ '/assets/../docs/screenshots/gui-session.png' | relative_url }}" alt="会话">
      <figcaption>会话——bash 卡片、转录、上下文圆环</figcaption>
    </figure>
    <figure class="mp-shot">
      <img src="{{ '/assets/../docs/screenshots/gui-settings.png' | relative_url }}" alt="设置">
      <figcaption>设置——336 项 TUI 设置，可搜索</figcaption>
    </figure>
  </div>
</section>

<section class="mp-section mp-reveal" id="quick-start">
  <h2>快速开始</h2>
  <div class="mp-quick">
<pre><span class="mp-cmd">bun run setup</span>                  # 安装 + natives + link
<span class="mp-cmd">bun run musepi</span>                 # 终端 TUI
<span class="mp-cmd">bun --cwd=packages/coding-agent src/cli.ts serve --port 8300</span>   # daemon
<span class="mp-cmd">bun --cwd=packages/gui run desktop</span>        # 桌面 GUI</pre>
  </div>
  <p style="color:var(--text-muted);font-size:14px">完整指南见 <a href="{{ 'README.zh-CN.md' | relative_url }}">README.zh-CN.md</a>。</p>
</section>

<section class="mp-section mp-reveal">
  <h2>文档</h2>
  <ul class="mp-docs">
    <li><a href="{{ 'docs/gui-design.md' | relative_url }}">GUI 设计规范——布局 / token / 动效 / 组件</a></li>
    <li><a href="{{ 'docs/mobile-design.md' | relative_url }}">移动端设计规范——界面 / 动效 / 原生 chrome</a></li>
    <li><a href="{{ 'docs/gui-implementation.md' | relative_url }}">GUI 实现笔记——daemon RPC 形状、坑、验证</a></li>
    <li><a href="{{ 'docs/widget-design-system.md' | relative_url }}">组件设计系统</a></li>
    <li><a href="{{ 'docs/board-dashboard.md' | relative_url }}">看板</a></li>
    <li><a href="{{ 'docs/collab.md' | relative_url }}">Collab 共享（LAN / 隧道 / Tailscale）</a></li>
    <li><a href="{{ 'UPSTREAM.md' | relative_url }}">上游同步跟踪</a></li>
  </ul>
</section>
