---
layout: default
title: MusePi — 结对工程师，处处与你同行
lang: zh-CN
en_url: /
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
      <h1 class="mp-hero-title">一位结对工程师，<br>处处与你同行。</h1>
      <p class="mp-hero-sub">
        MusePi 把液态玻璃桌面驾驶舱、常驻桌宠与移动伴侣接到同一个 daemon
        上——会话、设置与历史记录，从 GUI 到终端到手机一路随行。
      </p>
      <div class="mp-cta-row">
        <a class="mp-cta mp-cta--primary" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="arm64.dmg">下载 macOS 版</a>
        <a class="mp-cta mp-cta--soft" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="setup.exe">Windows · x64</a>
        <a class="mp-cta mp-cta--soft" href="https://github.com/MuseLinn/MusePi/releases/latest" data-asset="x86_64.AppImage">Linux</a>
        <a class="mp-cta mp-cta-ghost" href="https://github.com/MuseLinn/MusePi/tree/main/docs">阅读文档</a>
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
  <div class="mp-orb" aria-hidden="true">
    <svg viewBox="0 0 269 275" xmlns="http://www.w3.org/2000/svg" focusable="false">
      <defs>
        <radialGradient id="mp-orb-shell" cx="0.34" cy="0.26" r="0.92">
          <stop offset="0" stop-color="oklch(89.07% 0.0798 79.84)"/>
          <stop offset="0.5" stop-color="oklch(65% 0.105 79.84)"/>
          <stop offset="1" stop-color="oklch(33% 0.08 79.84)"/>
        </radialGradient>
        <linearGradient id="mp-orb-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="oklch(96% 0.07 85)"/>
          <stop offset="0.15" stop-color="oklch(96% 0.07 85)"/>
          <stop offset="0.5" stop-color="oklch(88% 0.135 82)"/>
          <stop offset="0.86" stop-color="oklch(52% 0.09 80)"/>
          <stop offset="1" stop-color="oklch(70% 0.11 81)"/>
        </linearGradient>
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
        <path d="M 15.4 149.5 A 104 34 -18 1 1 213.2 85.2" fill="none" stroke="url(#mp-orb-ring)" stroke-width="9" stroke-linecap="round" opacity="0.55"/>
        <circle cx="114.27" cy="114.27" r="114.27" fill="url(#mp-orb-shell)"/>
        <ellipse cx="80.27" cy="57.27" rx="31" ry="14" transform="rotate(-22 80.27 57.27)" fill="#ffffff" opacity="0.5"/>
        <ellipse cx="58.27" cy="84.27" rx="7" ry="4" transform="rotate(-22 58.27 84.27)" fill="#ffffff" opacity="0.35"/>
        <ellipse cx="94.27" cy="50.27" rx="15" ry="5.6" transform="rotate(-22 94.27 50.27)" fill="#ffffff" opacity="0.55"/>
        <ellipse cx="88" cy="112" rx="12.5" ry="17" fill="url(#mp-orb-eye)"/>
        <ellipse cx="141" cy="112" rx="12.5" ry="17" fill="url(#mp-orb-eye)"/>
        <path d="M 97 138 Q 114.5 152 132 138" fill="none" stroke="#f4f6f9" stroke-width="7" stroke-linecap="round"/>
        <path d="M 213.2 85.2 A 104 34 -18 1 1 15.4 149.5" fill="none" stroke="url(#mp-orb-ring)" stroke-width="9" stroke-linecap="round"/>
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

<section class="mp-stats mp-reveal" aria-label="MusePi 一览">
  <div class="mp-stat">
    <span class="mp-stat-num mp-stat-num--accent">60+</span>
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
        <p>完整驾驶舱——在窗口原生材质（Win11 亚克力 / macOS vibrancy）之上叠液态玻璃：
           镜面描边、液态弹簧动效，聊天与会话树都是一等公民。</p>
        <ul>
          <li>所有 TUI 设置合并进一个可搜索面板</li>
          <li>浮动状态卡让运行中的任务一目了然</li>
          <li>全程键盘驱动，中文排版优先</li>
          <li>设计模式：agent 先对齐简报、再判结构、最后产出可预览设计稿，而不是直接写代码</li>
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
        <li>60+ LLM 提供商，图像与视频生成内置</li>
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
      <h3><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="4.2"/><path d="M2.2 9.6a6.6 6.6 0 0 0 11.6 0" stroke-linecap="round"/></svg>常驻桌宠</h3>
      <p>会动的桌面伴侣，支持拖拽定位、点击穿透、悬停互动与任务气泡——
         Agent 状态一眼可见。</p>
    </div>
    <div class="mp-card">
      <h3><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><rect x="5" y="1.8" width="6" height="12.4" rx="1.6"/><path d="M7.2 12.2h1.6M11 5.4a4.2 4.2 0 0 1 0 5.2M12.8 3.6a6.8 6.8 0 0 1 0 8.8"/></svg>远程与移动</h3>
      <p>Android 伴侣扫码经局域网配对，三合一发送条——看运行、发提示、停回合。
         聊天机器人在 Discord、Telegram、飞书与微信里做同样的事，且各按各的原生能力：
         原生输入状态、引用成线程的回复、长回复分片而不是截断。</p>
    </div>
    <div class="mp-card">
      <h3><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.6l5.2 1.9v4c0 3.2-2.1 5.5-5.2 6.9-3.1-1.4-5.2-3.7-5.2-6.9v-4L8 1.6z"/><rect x="6.2" y="7" width="3.6" height="2.8" rx=".7"/><path d="M7 7V5.9a1 1 0 0 1 2 0V7"/></svg>端到端加密协作</h3>
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
      <div class="mp-dl-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div>
      <h3>桌面客户端</h3>
      <p class="mp-dl-sub">Electron GUI · 液态玻璃界面 · 自动更新</p>
      <ul class="mp-dl-list">
        <li><a data-asset="arm64.dmg" href="https://github.com/MuseLinn/MusePi/releases/latest">macOS（Apple Silicon）</a><span class="mp-dl-fmt">.dmg</span></li>
        <li><a data-asset="setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 10/11（x64）</a><span class="mp-dl-fmt">setup.exe</span></li>
        <li><a data-asset="arm64-setup.exe" href="https://github.com/MuseLinn/MusePi/releases/latest">Windows 11（ARM64）</a><span class="mp-dl-fmt">arm64-setup.exe</span></li>
        <li><a data-asset="x86_64.AppImage" href="https://github.com/MuseLinn/MusePi/releases/latest">Linux x64</a><span class="mp-dl-fmt">.AppImage · .deb</span></li>
      </ul>
    </div>
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.4"/><path d="M10.5 18.5h3"/></svg></div>
      <h3>Android 伴侣</h3>
      <p class="mp-dl-sub">Capacitor 应用 · 局域网配对 · 远程控制</p>
      <ul class="mp-dl-list">
        <li><a data-asset="app-debug.apk" href="https://github.com/MuseLinn/MusePi/releases/latest">Android arm64</a><span class="mp-dl-fmt">.apk</span></li>
        <li><a href="https://github.com/MuseLinn/MusePi/tree/main/packages/mobile">从源码构建（Capacitor）</a><span class="mp-dl-fmt">packages/mobile</span></li>
      </ul>
    </div>
    <div class="mp-dl-card">
      <div class="mp-dl-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M6.5 9.5l3.5 3-3.5 3M12.5 15.5H17"/></svg></div>
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
    <a class="mp-arrow-link" href="https://github.com/MuseLinn/MusePi/blob/main/README.md">阅读 README.md
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" fill="none"><path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </a>
  </div>
  <div class="mp-quick-code">
<pre><span class="mp-cmd">git clone https://github.com/MuseLinn/MusePi.git &amp;&amp; cd MusePi</span>
<span class="mp-cmd">bun run setup</span>                  <span class="mp-c"># 安装 + 原生依赖 + link</span>
<span class="mp-cmd">bun run musepi</span>                 <span class="mp-c"># 终端 TUI</span>
<span class="mp-cmd">bun run --cwd=packages/desktop-app desktop</span>   <span class="mp-c"># 桌面 GUI</span></pre>
  </div>
</section>

<section class="mp-section mp-reveal" id="docs">
  <h2>文档</h2>
  <p class="mp-section-desc">全部文档随仓库更新——每张卡片都指向 GitHub 上的最新版本，看到的永远是最新的。</p>
  <div class="mp-docs-grid">
    <a class="mp-doc-card" href="https://github.com/MuseLinn/MusePi/blob/main/docs/gui-design.md">
      <span class="mp-doc-title">GUI 设计规范</span>
      <span class="mp-doc-desc">布局 · 令牌 · 动效 · 组件</span>
    </a>
    <a class="mp-doc-card" href="https://github.com/MuseLinn/MusePi/blob/main/docs/gui-implementation.md">
      <span class="mp-doc-title">GUI 实现</span>
      <span class="mp-doc-desc">daemon RPC 契约 · 坑位 · 验证流程</span>
    </a>
    <a class="mp-doc-card" href="https://github.com/MuseLinn/MusePi/blob/main/docs/mobile-design.md">
      <span class="mp-doc-title">移动端设计规范</span>
      <span class="mp-doc-desc">界面 · 动效 · 原生外壳</span>
    </a>
    <a class="mp-doc-card" href="https://github.com/MuseLinn/MusePi/blob/main/docs/extensions-dev.md">
      <span class="mp-doc-title">扩展开发</span>
      <span class="mp-doc-desc">slots · HMR · API</span>
    </a>
    <a class="mp-doc-card" href="https://github.com/MuseLinn/MusePi/blob/main/packages/coding-agent/CHANGELOG.musepi.md">
      <span class="mp-doc-title">更新日志与发布说明</span>
      <span class="mp-doc-desc">每个版本的新变化，中英双语</span>
    </a>
    <a class="mp-doc-card" href="https://github.com/MuseLinn/MusePi/blob/main/UPSTREAM.md">
      <span class="mp-doc-title">上游同步追踪</span>
      <span class="mp-doc-desc">oh-my-pi 上游 · 合并策略</span>
    </a>
  </div>
</section>
