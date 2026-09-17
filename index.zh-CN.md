---
layout: default
title: MusePi — 一个 Agent，所有工作面
lang: zh-CN
en_url: /
mp_cta: true
---

<section class="mp-hero">
  <div class="mp-hero-grid">
    <div class="mp-hero-copy">
      <div class="mp-hero-badge">
        <span class="mp-pulse" aria-hidden="true"></span>
        <span class="mp-hero-badge-ver" data-release-version>v0.4.30</span>
        <span class="mp-hero-badge-sep" aria-hidden="true"></span>
        <span class="mp-hero-badge-meta">macOS · Windows · Linux · Android</span>
      </div>
      <h1 class="mp-hero-title">一个 Agent。<br>处处都是它的主场。</h1>
      <p class="mp-hero-sub">
        MusePi 把磨砂玻璃桌面驾驶舱、常驻桌宠与移动伴侣接到同一个 daemon
        上——会话、设置与历史记录，从 GUI 到终端到手机一路随行。
      </p>
      <div class="mp-cta-row">
        <a class="mp-cta mp-cta--primary" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="arm64.dmg">下载 macOS 版</a>
        <a class="mp-cta mp-cta--soft" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="setup.exe">Windows · x64</a>
        <a class="mp-cta mp-cta--soft" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="x86_64.AppImage">Linux</a>
        <a class="mp-cta mp-cta-ghost" href="{{ '/docs/' | relative_url }}">阅读文档</a>
        <div class="mp-cta-more">
          <button class="mp-cta mp-cta--soft mp-cta-more-btn" type="button" data-dl-more aria-haspopup="menu" aria-expanded="false">
            其他版本
            <svg class="mp-cta-more-chevron" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" fill="none"><path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="mp-cta-menu" role="menu" data-dl-menu hidden>
            <p class="mp-cta-menu-label">桌面端</p>
            <a role="menuitem" data-asset="arm64.dmg" href="https://github.com/MuseLinn/MusePi/releases/latest">macOS（Apple Silicon）<span>.dmg</span></a>
            <a role="menuitem" data-asset="setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 10/11（x64）<span>setup.exe</span></a>
            <a role="menuitem" data-asset="arm64-setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 11（ARM64）<span>arm64-setup.exe</span></a>
            <a role="menuitem" data-asset="x86_64.AppImage" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64<span>.AppImage</span></a>
            <a role="menuitem" data-asset="amd64.deb" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64<span>.deb</span></a>
            <a role="menuitem" data-asset="arm64.AppImage" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux ARM64<span>.AppImage</span></a>
            <a role="menuitem" data-asset="arm64.deb" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux ARM64<span>.deb</span></a>
            <p class="mp-cta-menu-label">移动端</p>
            <a role="menuitem" data-asset="app-debug.apk" href="https://github.com/MuseLinn/MusePi/releases/latest">Android arm64<span>.apk</span></a>
            <p class="mp-cta-menu-label">校验</p>
            <a role="menuitem" data-asset="SHA256SUMS.txt" href="https://github.com/MuseLinn/MusePi/releases/latest">SHA256SUMS.txt<span>校验文件</span></a>
            <a role="menuitem" href="https://github.com/MuseLinn/MusePi/releases">全部版本与 beta 构建</a>
          </div>
        </div>
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
      <p class="mp-term-hint">一行命令装好 daemon、TUI 与桌面应用。需要 Node ≥ 22 或 Bun。</p>
    </aside>
  </div>
</section>

<section class="mp-stats mp-reveal" aria-label="MusePi 一览">
  <div class="mp-stat">
    <span class="mp-stat-num mp-stat-num--accent">40+</span>
    <span class="mp-stat-label">LLM 提供商</span>
  </div>
  <div class="mp-stat">
    <span class="mp-stat-num">5</span>
    <span class="mp-stat-label">支持的平台</span>
  </div>
  <div class="mp-stat">
    <span class="mp-stat-num">2</span>
    <span class="mp-stat-label">扩展中心</span>
  </div>
  <div class="mp-stat">
    <span class="mp-stat-num">1</span>
    <span class="mp-stat-label">共享 daemon</span>
  </div>
</section>

<section class="mp-demo mp-reveal" id="demo">
  <header class="mp-demo-head">
    <p class="mp-demo-kicker">实地演示</p>
    <h2>一个 daemon。三个工作面。</h2>
    <p class="mp-demo-desc">哪个场合顺手就用哪个——每个面都连着同一批会话、同一套设置、
       同一批正在运行的任务。</p>
  </header>
  <div class="mp-demo-tabs" role="tablist" aria-label="工作面">
    <button class="mp-demo-tab is-active" type="button" data-demo-tab="gui" role="tab" aria-selected="true">桌面 GUI</button>
    <button class="mp-demo-tab" type="button" data-demo-tab="tui" role="tab" aria-selected="false">终端 TUI</button>
    <button class="mp-demo-tab" type="button" data-demo-tab="mobile" role="tab" aria-selected="false">移动伴侣</button>
  </div>
  <div class="mp-demo-stage">
    <figure class="mp-demo-preview">
      <div class="mp-demo-chrome" aria-hidden="true">
        <span class="mp-demo-lights"><i></i><i></i><i></i></span>
        <span class="mp-demo-chrome-title" data-demo-chrome>MusePi — 欢迎页</span>
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
              <p class="mp-demo-greet-hi">晚上好</p>
              <p class="mp-demo-greet-sub">三个会话空闲中——daemon 正在值守。</p>
            </div>
            <div class="mp-demo-composer">
              <span class="mp-demo-composer-ph">随便问——/ 唤起命令，@ 引用文件</span>
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
            <div class="mp-demo-phone-head">MusePi <span>在线</span></div>
            <div class="mp-demo-bubble">在 main 会话里跑 `bun test`？</div>
            <div class="mp-demo-bubble mp-demo-bubble--me">好——有失败就停下来</div>
            <div class="mp-demo-bubble"><span class="mp-demo-tui-ok">✓</span> 243 通过 · 回合已停止</div>
            <div class="mp-demo-phone-send">提问、粘贴或停止——一根发送条 <span aria-hidden="true">→</span></div>
          </div>
          <p class="mp-demo-mobile-note">扫码配对，局域网直连——端到端加密。</p>
        </div>
      </div>
      <figcaption class="mp-demo-caption" data-demo-caption>欢迎页——点阵品牌背景，按时段变化的问候</figcaption>
    </figure>
    <aside class="mp-demo-panels">
      <article class="mp-demo-panel is-active" data-demo-panel="gui">
        <h3>桌面客户端</h3>
        <p>完整驾驶舱——真实的磨砂玻璃窗口材质（Win11 亚克力 / macOS vibrancy），
           聊天与会话树都是一等公民。</p>
        <ul>
          <li>所有 TUI 设置合并进一个可搜索面板</li>
          <li>浮动状态卡让运行中的任务一目了然</li>
          <li>全程键盘驱动，中文排版优先</li>
        </ul>
      </article>
      <article class="mp-demo-panel" data-demo-panel="tui">
        <h3>终端 TUI</h3>
        <p>同一个 Agent 搬进终端——键盘优先、SSH 友好，会话与设置完全一致。</p>
        <ul>
          <li>/tree、/trace 与桌面端同款斜杠命令</li>
          <li>共用同一个 daemon，这里发起的运行在那边继续推送</li>
          <li>一行命令安装——无需 Electron</li>
        </ul>
      </article>
      <article class="mp-demo-panel" data-demo-panel="mobile">
        <h3>移动伴侣</h3>
        <p>Android 应用，扫码经局域网配对——看运行、发提示、随时停。</p>
        <ul>
          <li>三合一发送条：提问、粘贴上下文、停止回合</li>
          <li>实时会话状态，与桌面端同一棵会话树</li>
          <li>端到端加密——不经过任何第三方服务器</li>
        </ul>
      </article>
    </aside>
  </div>
</section>

<section class="mp-features mp-reveal" id="features">
  <header class="mp-section-head">
    <p class="mp-demo-kicker">为什么选 MusePi</p>
    <h2>为你真实的工作方式而生</h2>
  </header>
  <article class="mp-feature">
    <div class="mp-feature-copy">
      <p class="mp-feature-kicker">会话即树</p>
      <h3>每个回答都长在树上</h3>
      <p>每条消息都带着父节点——历史是一棵可以走的树，而不是只能回放的日志。
         从任意节点分叉、复刻、回退、重新回答。</p>
      <ul class="mp-feature-points">
        <li>画布地图画出完整的会话 DAG</li>
        <li>轨迹面板把同一棵树投影成时间线</li>
      </ul>
    </div>
    <figure class="mp-feature-media">
      <div class="mp-feature-mock" aria-hidden="true">
        <aside class="mp-mock-side">
          <span class="mp-mock-side-title">会话</span>
          <span class="mp-mock-tree is-active"></span>
          <span class="mp-mock-tree mp-mock-tree--branch"></span>
          <span class="mp-mock-tree mp-mock-tree--branch2"></span>
          <span class="mp-mock-tree"></span>
          <div class="mp-mock-donut"><i></i></div>
          <span class="mp-mock-donut-label">上下文 72%</span>
        </aside>
        <div class="mp-mock-chat">
          <div class="mp-mock-bubble mp-mock-bubble--user">把 FilePane 重构成 flex column 并加自动保存</div>
          <div class="mp-mock-tool"><span class="mp-mock-tool-name">grep</span><span class="mp-mock-tool-arg">autosave · FilePane</span><span class="mp-mock-tool-ok">14 个文件</span></div>
          <div class="mp-mock-tool"><span class="mp-mock-tool-name">edit</span><span class="mp-mock-tool-arg">FilePane.tsx + autosave.ts</span><span class="mp-mock-tool-ok">+96 −41</span></div>
          <div class="mp-mock-ai">三个文件已改完——编辑器列保持 flex 链路，未保存修改现在会在 tab 上打点，切换或关闭前会先确认。</div>
          <div class="mp-mock-input">回复，或调整计划…<span class="mp-mock-input-send"></span></div>
        </div>
      </div>
      <figcaption>会话——对话记录、带实时结果的工具行、树上的上下文环</figcaption>
    </figure>
  </article>
  <article class="mp-feature mp-feature--flip">
    <div class="mp-feature-copy">
      <p class="mp-feature-kicker">Agent 引擎与扩展</p>
      <h3>一台可以边飞边换零件的引擎</h3>
      <p>一切皆可插拔：模型提供商、工具、UI 表面——daemon 盯着你的扩展目录，
         热重载随时生效。</p>
      <ul class="mp-feature-points">
        <li>40+ LLM 提供商，图像与视频生成内置</li>
        <li>浏览器 + computer-use 工具、LSP/DAP、任务子代理</li>
        <li>两个扩展中心——slots、工具视图、RPC、主题</li>
      </ul>
    </div>
    <figure class="mp-feature-media">
      <div class="mp-feature-mock mp-feature-mock--settings" aria-hidden="true">
        <aside class="mp-mock-side">
          <span class="mp-mock-side-title">设置</span>
          <span class="mp-mock-set-row">通用</span>
          <span class="mp-mock-set-row is-active">模型</span>
          <span class="mp-mock-set-row">API 密钥</span>
          <span class="mp-mock-set-row">外观</span>
          <span class="mp-mock-set-row">扩展</span>
        </aside>
        <div class="mp-mock-chat">
          <div class="mp-mock-search">搜索所有 TUI 设置…</div>
          <div class="mp-mock-pref"><span>默认模型</span><b>deepseek-v4-flash</b></div>
          <div class="mp-mock-pref"><span>思考档位</span><b>high</b></div>
          <div class="mp-mock-pref"><span>桌面通知</span><i class="mp-mock-toggle is-on"></i></div>
          <div class="mp-mock-pref"><span>常驻桌宠</span><i class="mp-mock-toggle is-on"></i></div>
          <div class="mp-mock-pref"><span>遥测</span><i class="mp-mock-toggle"></i></div>
        </div>
      </div>
      <figcaption>设置——所有 TUI 设置，可搜索、已分组</figcaption>
    </figure>
  </article>
  <div class="mp-bento">
    <div class="mp-card">
      <h3><span class="mp-dot"></span>常驻桌宠</h3>
      <p>会动的桌面伴侣，支持拖拽定位、点击穿透、悬停互动与任务气泡——
         Agent 状态一眼可见。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>远程与移动</h3>
      <p>Android 伴侣扫码经局域网配对，三合一发送条——看运行、发提示、停回合。</p>
    </div>
    <div class="mp-card">
      <h3><span class="mp-dot"></span>端到端加密协作</h3>
      <p>访客可远程管理会话、停止运行中的回合——全程端到端加密，
         不经过任何第三方服务器。</p>
    </div>
  </div>
</section>

<section class="mp-section mp-reveal" id="download">
  <h2>下载</h2>
  <p class="mp-section-desc">三种方式运行 MusePi——哪个顺手用哪个。桌面构建是带应用内自动更新的
  tag 发布；TUI 一行命令安装；Android 与桌面 daemon 经局域网配对。</p>
  <div class="mp-dl-grid">
    <div class="mp-dl-card">
      <div class="mp-dl-icon mp-dl-icon--desktop" aria-hidden="true"></div>
      <h3>桌面客户端</h3>
      <p class="mp-dl-sub">Electron GUI · 磨砂玻璃窗口 · 自动更新</p>
      <ul class="mp-dl-list">
        <li><a data-asset="arm64.dmg" href="https://github.com/MuseLinn/MusePi/releases/latest">macOS（Apple Silicon）</a><span class="mp-dl-fmt">.dmg</span></li>
        <li><a data-asset="setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 10/11（x64）</a><span class="mp-dl-fmt">setup.exe</span></li>
        <li><a data-asset="arm64-setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 11（ARM64）</a><span class="mp-dl-fmt">arm64-setup.exe</span></li>
        <li><a data-asset="x86_64.AppImage" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64</a><span class="mp-dl-fmt">.AppImage · .deb</span></li>
      </ul>
    </div>
    <div class="mp-dl-card">
      <div class="mp-dl-icon mp-dl-icon--mobile" aria-hidden="true"></div>
      <h3>Android 伴侣</h3>
      <p class="mp-dl-sub">Capacitor 应用 · 局域网配对 · 远程控制</p>
      <ul class="mp-dl-list">
        <li><a data-asset="app-debug.apk" href="https://github.com/MuseLinn/MusePi/releases/latest">Android arm64</a><span class="mp-dl-fmt">.apk</span></li>
        <li><a href="https://github.com/MuseLinn/MusePi/tree/main/packages/mobile">从源码构建（Capacitor）</a><span class="mp-dl-fmt">packages/mobile</span></li>
      </ul>
    </div>
    <div class="mp-dl-card">
      <div class="mp-dl-icon mp-dl-icon--tui" aria-hidden="true"></div>
      <h3>终端 TUI</h3>
      <p class="mp-dl-sub">完整的 Agent 工作面，就在你的终端里</p>
      <div class="mp-hero-code mp-hero-code--tight">
<pre><span class="mp-cmd">curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh</span>   <span class="mp-c"># macOS / Linux / WSL</span>
<span class="mp-cmd">git clone https://github.com/MuseLinn/MusePi.git &amp;&amp; cd MusePi</span>
<span class="mp-cmd">bun run setup &amp;&amp; bun run musepi</span>   <span class="mp-c"># Windows · 从源码</span></pre>
      </div>
      <p class="mp-dl-sub">需要 Node ≥ 22 或 Bun。与桌面应用同会话、同 daemon、同设置。</p>
    </div>
  </div>
  <p class="mp-dl-note">每个 release 都附带 <code>update-manifest.json</code> 供应用内
  自动更新；beta 渠道构建以
  <a href="https://github.com/MuseLinn/MusePi/releases">pre-release</a> 形式发布。</p>
</section>

<section class="mp-section mp-quick mp-reveal" id="quick-start">
  <div class="mp-quick-copy">
    <p class="mp-demo-kicker">从源码开始</p>
    <h2>三条命令跑起来</h2>
    <p>完整指南在 README.md——daemon 架构、提供商配置、移动端构建与协作分享。</p>
    <a class="mp-arrow-link" href="{{ 'README.md' | relative_url }}">阅读 README.md
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" fill="none"><path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </a>
  </div>
  <div class="mp-quick mp-quick-code">
<pre><span class="mp-cmd">git clone https://github.com/MuseLinn/MusePi.git &amp;&amp; cd MusePi</span>
<span class="mp-cmd">bun run setup</span>                  <span class="mp-c"># 安装 + 原生依赖 + link</span>
<span class="mp-cmd">bun run musepi</span>                 <span class="mp-c"># 终端 TUI</span>
<span class="mp-cmd">bun run --cwd=packages/desktop-app desktop</span>   <span class="mp-c"># 桌面 GUI</span></pre>
  </div>
</section>

<section class="mp-section mp-reveal" id="docs">
  <h2>文档</h2>
  <div class="mp-docs-grid">
    <a class="mp-doc-card" href="{{ 'docs/gui-design.md' | relative_url }}">
      <span class="mp-doc-title">GUI 设计规范</span>
      <span class="mp-doc-desc">布局 · 令牌 · 动效 · 组件</span>
    </a>
    <a class="mp-doc-card" href="{{ 'docs/gui-implementation.md' | relative_url }}">
      <span class="mp-doc-title">GUI 实现</span>
      <span class="mp-doc-desc">daemon RPC 契约 · 坑位 · 验证流程</span>
    </a>
    <a class="mp-doc-card" href="{{ 'docs/mobile-design.md' | relative_url }}">
      <span class="mp-doc-title">移动端设计规范</span>
      <span class="mp-doc-desc">界面 · 动效 · 原生外壳</span>
    </a>
    <a class="mp-doc-card" href="{{ 'docs/extensions-dev.md' | relative_url }}">
      <span class="mp-doc-title">扩展开发</span>
      <span class="mp-doc-desc">slots · HMR · API</span>
    </a>
    <a class="mp-doc-card" href="{{ 'docs/archive/board-dashboard.md' | relative_url }}">
      <span class="mp-doc-title">看板与组件系统</span>
      <span class="mp-doc-desc">widget 设计系统 · registry</span>
    </a>
    <a class="mp-doc-card" href="{{ 'UPSTREAM.md' | relative_url }}">
      <span class="mp-doc-title">上游同步追踪</span>
      <span class="mp-doc-desc">oh-my-pi 上游 · 合并策略</span>
    </a>
  </div>
</section>
