# Modes (预设/Profile) 规划文档

> 状态:**已实现（v1+v2，2026-08-21 提交 7bff540c13 / 457039db31）**。目标:命名预设 = { 扩展工具集 + 系统提示词 + settings 覆盖 } 的聚合与切换,支撑 Work / Design 等角色模式。
> 2026-08-25 核对:`presets/resolve.ts`（createModeResolver/resolve）、`prompts/composer.ts`（PromptComposer）、sdk.ts modeId 全链路、server.ts modes.list/get RPC + modes.changed 广播均已在。
> 关联:扩展 HMR v2 契约(`docs/extension-hmr-v2-plan.md`)、ModelSelector 三态语义(已修)。

## 1. 背景与目标

用户要在**输入框选择 Profile**、并能切换 Work / Design 模式(不同预设工具、系统提示词)。调查结论(§2):musepi 已有全部原子能力(会话级动态工具 = P5 reloadExtension、会话级提示词 = `setSystemPrompt`、输入框选择器 = ModelSelector、扩展白名单 = disabledExtensions glob),**缺的是"命名预设"聚合层**。

### 1.1 呈现层(已定)

- **设置 tab「预设」区块**:预设列表 + 编辑页(选扩展集合、写提示词、调 settings 覆盖;组合预设显示"基于 Design + autoresearch"继承来源行)。嵌套不暴露为 UI 层级。
- **输入框模式 chip**:ModelSelector 旁一个模式 chip,点开 = 预设列表平铺;选一个即应用。三态语义与 ModelSelector 一致(空态显示默认 mode;会话态 = 该会话 mode;切换会话不继承)。

### 1.2 v1 / v2 分界

- **v1(零新增运行时路径)**:mode 仅在**会话创建时**应用 —— 工具集白名单过滤 + 提示词注入 + settings 合并,一次性组装。提示词模型 §5 的 PromptComposer **v1 即完整落地**(注入点 = 既有 `buildSystemPrompt` 数组级,不动模板)。
- **v2(新增 `ExtensionRunner` 启用方向)**:会话中**热切换**。advisory 确认:reloadExtension 只按 path 替换已加载条目(`runner.ts` findIndex 替换),**启用方向(会话运行时新增扩展条目)无路径** —— 需新增 `loadExtension(path)`(发现未加载目录 → 加载 → registerTool → 注册进 `this.extensions`),与 P5 loader 共用,单点工作量。v2 同时开放**扩展提示词贡献**(registerPrompt,§5.5)与 prompt 热切换(增量更新,§5.6)。

## 2. 设计依据:DSH profile / 提示词对照

### 2.1 DSH profile(deepseek-harness `packages/boot/app-boot/src/profile.ts`)

- 目录 `$DSH_HOME/profiles/<name>/`,含 `package.json`(`dsh.profile.bundles` 有序列表)+ `cordis.patch.yml`(用户 patch 层)。
- **bundles** = 可复用插件组合包,各自导出 `dsh.bundle.patch`;组合顺序:空插件表 → bundles 按序叠加各 patch → profile 自身 patch → launcher 层(`--patch` + flag)。
- 内置模板:`web` = [dsh-base, dsh-web-app]、`headless` = [dsh-base, dsh-headless],首次使用自动初始化。
- patch 条目 = id-targeted 配置覆盖 / 禁用 / 插入列表(YAML,`!!js` 表达式);profile patch 热重载。

### 2.2 DSH 提示词模型(`app-boot/src/index.ts`)

`systemPrompt` 是 cordis **service**,插件通过 `section({ name, order, text })` 贡献**命名 + 排序的提示词区块**,按 `order` 聚合组装成完整 system prompt。实例:`addHarnessSourceSection` 以 `order: -99` 插入(harness identity opener `-100` 之后、deployment persona `0` 之前)。区块挂在 service fiber 上,插件 HMR 重载会 drop 旧区块直到下次 boot。persona 只是其中一个区块。**区块共存(非覆盖)是核心语义** —— 各贡献方按 order 混排,只有同 id-targeted 的 patch 才能覆盖/禁用。

### 2.3 musepi 现有提示词结构(`packages/coding-agent/src/system-prompt.ts`)

`buildSystemPrompt()` 输出 `systemPrompt: string[]`,结构:

| 数组元素 | 内容 | 构造 |
|---|---|---|
| `[0]` | 主模板渲染 | `system-prompt.md` handlebars:identity + **personality 数据块** + customPrompt(SYSTEM.md)+ tools 清单 + contextFiles(AGENTS.md…)+ appendPrompt |
| `[1]`(条件) | computerSafetyPrompt | 尾部 push |
| `[2]`(条件) | projectPrompt | 尾部 push |
| `[3]`(条件) | activeRepoContextPrompt | 尾部 push |

personality 是**模板内数据**(`PERSONALITY_SPECS` 三档 md),不是独立数组元素;`setSystemPrompt` 整体替换(`agent-session.ts:1180`)。现有"区块"只有数组级 3-4 个,模板内区块不可单独寻址。

### 2.4 映射结论

| DSH | musepi 采用 |
|---|---|
| bundles 嵌套组合 | ✅ 轻量继承(§4.2):预设 `extends` 其他预设,展开为并集,非完整 bundle 包机制 |
| patch 4 层 | ✅ 2 层:预设展开 → **用户全局显式值最后生效**(§4.3) |
| cordis id-targeted patch 语法 | ❌ 不用:musepi 扩展已有 registerSetting 声明式配置,预设用 settings 片段合并 |
| **systemPrompt section{name,order,text} 共存语义** | ✅ **v1 即采用** section 模型(§5):PromptComposer 数组级注入,不重构模板;personality 仍为模板内数据,v2 再考虑模板级拆分 |
| section 覆盖/禁用 | ⚠️ v1 只支持同名覆盖 + `promptComplete` 整体替换;per-section 禁用/模板内 patch 留 v2 |
| 扁平 node_modules + pnpm workspace | ❌ bun workspace 无关 |

### 2.5 DSH 内置四个 Agent 预设(证据:`apps/cli/config/agent-presets/`)

| 预设 | 形态 | composition 关键点 |
|---|---|---|
| **standard** | 完整编码 agent(默认) | 全工具 + persona + skills/planning/goals/subagents;persona 为 config 文本,`{{model}}`/`{{cwd}}` 插值 |
| **code** | Standard + Code Mode SDK | 工具经 SDK 暴露,模型可写一个 TS 程序组合多步操作 |
| **minimal** | **极简/Cheap & Fast**(两工具) | persona `complete: true`(固定 prompt,身份/工具引导/后续监听**均不能加文本**)+ `includeRuntimeContext: false` + 仅 persistent bash + str_replace_editor + **无 context compaction** |
| **cordis (Creator)** | 创作预设的预设 | standard + 自引用 cordis 工具集 + 创作 skill;信任声明"等价 shell 访问" |

对 musepi 设计的三条直接输入:
1. **minimal 的 `complete: true`** = "该 persona 是完整 system prompt" —— musepi 用 `promptComplete` 对齐(§5.2),语义:complete 时 composer 忽略**一切**其他注入(内置 core/safety/project/repo-context 与全部继承链区块)。
2. **minimal 的 settings 维度**:`compaction.enabled: false` + 关闭 activeRepoContext —— musepi 均有对应设置键,minimal 模板直接带上。
3. **Creator 预设** = 创作预设的元预设;musepi 的对应物是设置页预设编辑器 + 现有 `musepi-extension-dev` bundled skill,不引入 cordis 自引用工具集(范围外,决策 #12)。

### 2.6 运行时态覆盖(创作闭环,裁决)

DSH cordis 预设靠自引用工具集(`cordis_mount`:评估 model 写的 JS 操作 live runtime)覆盖运行时态。musepi **以文件 + reload 等价覆盖,且更安全**:

| DSH cordis_mount(运行时对象操作) | musepi(文件 → 运行时同步) |
|---|---|
| 试验一个插件行 | 模型用 write 改扩展文件(registerTool 等声明) |
| 挂载到 live runtime | 保存 → P5 watcher → `reloadExtension`(runner.ts:879,同进程替换)→ 会话内即时生效 |
| 评估 model 写的 JS | reload 即执行入口 TS/JS(Bun);扩展加载/执行错误走 `ExtensionErrorListener`/`emitError`(runner.ts:86/439),**局部错误事件,不炸会话** |

musepi 形式更安全:改动先落盘 → 可 diff、可回滚、可审计;无额外特权(写扩展 = 普通文件写权限),不需要 cordis_mount 的"等价 shell 访问"信任警告。

**真实差异(2 个)**:
1. **无 dry-run 预览层**:reload 即生效,没有"这代码会注册什么"的预览
2. **无运行时自省工具**:会话内不能查"当前挂载了哪些扩展、各注册了什么工具/组件/settings"

**裁决(决策 #13)**:
- **不引入 cordis_mount 等价物**(musepi 扩展态 = 文件态,无运行时结构成分;造了即空壳)
- **`extensions.inspect` RPC(v2 候选)**:当前会话扩展清单 + 注册内容(信息 runner 已有,暴露即得,低成本)—— 满足"我改了,现在挂载了什么"的创作反馈环
- **`extensions.dryRun` 不做,除非隔离评估**:advisory 确认 —— "load 到临时 registry" 仍会在进程内 import 模块,顶层副作用(网络/写盘)照常执行,预览语义被击穿;subprocess/沙箱隔离评估成本显著上升,不划算。务实安全网 = 既有错误隔离 + 文件回滚

## 3. 数据形状

文件:`~/.musepi/modes/<id>.json`(全局,跨项目;id = 文件名)。

```jsonc
{
  "id": "design",
  "label": "Design",
  "description": "UI/UX 设计模式",
  "extends": ["ui-ux-pro-max"],          // 子预设引用(可选,展开见 §4)
  "modelRole": "design",                 // 可选:创建会话时的默认模型档位(settings.modelRoles 键,§6.1)
  "extensions": ["image-tools", "svg-tools", "canvas", "ui-ux-pro-max"],
  "prompt": [
    { "name": "mode:design:role", "order": 25, "text": "你是一名资深 UI/UX 设计师。优先给出视觉方案而非代码。" },
    { "name": "mode:design:layout", "order": 26, "text": "涉及布局时优先 Bento Grid / Neo-Brutalism 风格判断。" }
  ],
  "promptComplete": false,               // true = 该 prompt 集成为完整 system prompt,忽略内置区块与继承链(§5.2)
  "settings": { "image.generation": "agnes", "composer.showTokens": true }
}
```

轻量模式示例(内容层极简,参考 DSH minimal / Cheap & Fast):

```jsonc
{
  "id": "chat",
  "label": "Chat",
  "description": "极简对话:仅内置核心工具 + 固定 prompt + 无压缩",
  "modelRole": "fast",                   // → settings.modelRoles["fast"] 或内置 fast 角色
  "extensions": [],                      // 显式空 = 仅内置核心工具(三态语义见下)
  "prompt": [
    { "name": "mode:chat:persona", "order": 0, "text": "你是一名简洁的对话助手。只回答结论,不做多余分析;优先给出最小可行的方案。" }
  ],
  "promptComplete": true,                // = DSH persona complete:true —— 该 prompt 集是完整 system prompt(§5.2)
  "runtimeContext": false,               // 缺省 true;false = 关闭 activeRepoContext 区块(参考 DSH includeRuntimeContext:false)
  "settings": { "compaction.enabled": false, "composer.showTokens": false }
}
```

> 注:极简有两个正交维度 —— **内容层**(少工具 + 快模型 + 固定 prompt,= 上述 mode 数据)与**形态层**(headless 一次性执行,见决策 #11,musepi 已有 headless modes + `$env.NULL_PROMPT`,不进 mode 数据)。DSH minimal preset 同时含两层;mode 只承接内容层,形态层沿用既有 headless 启动。

- `extensions` **三态语义**:键缺省 = 全部启用;`[]` = 显式空(不加载任何扩展,仅内置核心工具 —— 极简模式的实现路径);显式数组 = 启用白名单。展开后 = 该 mode 的扩展集合。
- `modelRole` 可选:会话创建时的**默认模型档位**(§6.1)。引用 `settings.modelRoles` 键或内置角色(fast/small/slow 等 `model-resolver.ts` 既有机制),**不复制模型列表** —— 模型档位是现成能力,mode 只绑默认值。
- `promptComplete` 可选(缺省 false):参考 DSH persona `complete: true` —— 该 mode 的 prompt 集成为**完整 system prompt**,composer 忽略内置区块(core/safety/project/repo-context)与全部继承链 prompt(§5.2)。
- `runtimeContext` 可选(缺省 true):`false` = 会话创建时向 `buildSystemPrompt` 传 `activeRepoContext: null`(关闭该区块;参考 DSH minimal 的 `includeRuntimeContext: false`)。继承:链上任一显式 `false` → false(极简意图优先,安全方向)。
- `prompt` 为 **PromptSection 数组**(§5.1);**string 快捷语法**合法:`"你是一名资深设计师"` ≡ `{ name: "mode:<id>:<n>", order: <默认>, text: "…" }`(设置页保存时展开为对象,便于编辑页展示)。
- `settings` 为覆盖片段,展开合并进会话有效 settings;缺省 = 无覆盖。

## 4. 继承展开算法(`modes/resolve.ts`,纯逻辑、可单测)

### 4.1 展开

```
resolveMode(id):
  visited = {}          # 环检测
  stack  = []           # 拓扑序(先被引用的先应用)
  dfs(m):
    visited[m] = visiting
    for p in m.extends: dfs(p)          # 悬空引用/环 → 抛错(带 id 链)
    visited[m] = done; stack.push(m)
  展开 stack 顺序:
    extensions = 并集(去重,保持拓扑序)
    prompt     = sections 混排(§5.2:同名子胜;promptComplete 整体替换)
    settings   = 依次合并(后者胜出)
    runtimeContext = 链上任一显式 false → false(缺省 true)
```

> **extensions 并集 = 共存语义**(与 prompt 追加对齐):组合预设保留父预设的扩展集合,子预设无法"清空"父的列表(并集下 `[]` 是空集,不贡献)。要"只用子集"→ 不 extends 自写完整列表;若将来需要"清空父扩展"的逃生门,仿 promptComplete 增加 `extensionsComplete` 键(决策 #15,当前不做)。

- 环 / 悬空引用:**保存时校验**(设置页报错拒绝保存)+ 启动时二次校验。
- 展开结果缓存:mode 文件 mtime 变更即失效(与 P5 entryMtimes 模式一致)。

### 4.2 嵌套 = 一行继承

`extends` 独立字段(不混入 `extensions` 数组):预设名与扩展 id 无命名空间,混在数组里字符串无法区分。组合例:`design-research = { extends: ["design", "autoresearch"] }` → 展开 = 设计工具 + 调研工具并集;prompt sections 按 §5.2 混排(design 的 persona 区块**保留**,autoresearch 区块加入 —— DSH section 共存语义);settings 按拓扑序后者胜出。

### 4.3 用户全局覆盖 > 预设(最后应用)

应用链 = 预设展开结果 → **用户全局显式值**(`settings` 文件手写键、`disabledExtensions` glob、用户 prompt 区块 §5.4)最后覆盖。语义:用户显式禁用 > 预设启用;用户手写 settings 键 > 预设覆盖;用户 prompt 区块与预设同名 > 预设。防止预设"复活"用户明确禁用的扩展 / 覆盖用户选择。

## 5. 提示词模型(PromptComposer)

### 5.1 section 形状

```ts
interface PromptSection {
  name: string;     // 唯一 id:"mode:<id>:<slug>" | "user:<slug>" | "ext:<extId>:<slug>"
  order: number;    // 相对既有区块的插入位置(见 order 常量表)
  text: string;
  source: string;   // "mode:<id>" | "user" | "ext:<extId>",按 source 分组清理(§5.6)
}
```

**order 常量表**(与现有 `buildSystemPrompt` 数组对齐):

| order | 区块 | 现有对应 |
|---|---|---|
| 0 | 主模板(identity/personality/customPrompt/tools/contextFiles/appendPrompt) | `systemPrompt[0]` |
| 25(默认) | **mode / 用户 / 扩展注入区块**(角色 persona 贴近身份) | 新数组元素 |
| 100 | computerSafety | `systemPrompt[1]` |
| 200 | projectPrompt | `systemPrompt[2]` |
| 300 | activeRepoContext | `systemPrompt[3]` |

注入 = 在既有数组元素间按 order 插槽:`core < (≤25) < safety < project < repo-context`。order 建议区间:模式 persona 用 10–30(紧贴身份),独立规则 40–90(safety 前);>300 落入 repo-context 之后(尾部追加)。

### 5.2 合并语义(继承 + 优先级)

- **共存(默认)**:extends 链上各预设的 sections 按 order **混排**,互不覆盖 —— DSH section 语义。`design-research extends design` 时 design 的 persona 保留,衍生预设**不能静默抹掉**父预设 persona。
- **同名覆盖**:继承链中后声明预设的同 `name` section 覆盖先声明者(子胜父);用户区块同名 > mode(§4.3)。
- **完整替换** = `promptComplete: true`(参考 DSH persona `complete: true`,§2.5):该 mode 的 prompt 集成为**唯一** system prompt —— composer 忽略内置区块(core/safety/project/repo-context)与全部继承链 prompt,只输出本预设 sections。极简/固定 persona 的逃生门,比"替换继承链"更强(连内置区块一起排除,否则不算 complete)。设置页该开关 + 提示文案("该预设的提示词将成为完整系统提示词,覆盖内置区块与继承内容")。
- **替换 vs 追加的取舍**:默认追加参考 DSH 共存(组合预设 = 多个角色区块并存);要"Design 完全换掉基础 persona"→ 不 extends 自写全量 + `promptComplete: true`。

### 5.3 composer 核心(纯逻辑,可单测)

```ts
class PromptComposer {
  sections: Map<string, PromptSection>;   // key = name;同名替换,source 记录
  add(section, source)                    // 注册区块
  removeBySource(source)                  // 按贡献方整体卸载(热切换/扩展 reload)
  compose(base: string[]): string[]       // base = buildSystemPrompt 输出;按 order 插槽排序合并,输出 string[]
}
```

- `compose(base)` 无任何 mode/用户区块时返回 `base` 原样(**零行为变化**,向后兼容保证)。
- 同名冲突:后 add 者胜(继承展开已在 resolve 层定序,composer 只做插槽)。

### 5.4 用户全局提示词区块(v1 补强)

settings 新增 `prompt.sections: PromptSection[]`(settings-schema 的 `personality` 键旁,`settings-schema.ts:1312` 附近)。语义:用户自定义提示词区块,优先级高于一切预设(§4.3)。给"不用 mode 但想加自己的规则"的用户一个 DSH 用户 patch 层的轻量对应物。order 默认 25,用户可指定。

### 5.5 扩展贡献(v2)

扩展 API 新增 `registerPrompt(section)`(对应 DSH 插件 section 贡献)。生命周期:扩展注册时 add,`reloadExtension` 时 `removeBySource("ext:<extId>")` → 重新 add。`registerMode`(扩展声明预设)同为 v2 候选,与 registerPrompt 可合并设计(扩展导出一个预设时,其 prompt 区块 source = `mode:<id>`)。

### 5.6 热切换增量(v2)

`session.setMode` 时:composer `removeBySource("mode:<old>")` → add 新 mode sections → `compose(base)` 重算 → `setSystemPrompt(composed)`。base(主模板等)重跑一次 `buildSystemPrompt`(mtime 缓存按 P5 模式)或沿用会话初始 base —— **沿用初始 base** 更简单且一致(模板/contextFiles 本就按会话快照),mode 只动注入层。扩展 reload 同理只动扩展 source 层。

### 5.7 与既有调用点集成

- **挂点(精确化)**:composer 包装会话创建时传入的 `rebuildSystemPrompt` 回调(`session-tools.ts:231` SessionToolsOptions)—— `buildSystemPrompt(...)` → `composer.compose(base, mode + user sections)` → 返回。这样 **refresh/rebuild 两条路径**(`#refreshBaseSystemPrompt` 1355、`applyActiveToolsByName` 831)统一覆盖:工具集变化触发的重建自动重新注入 mode 区块,无遗漏。
- `setBaseSystemPrompt(prompt: string[])` 签名(`session-tools.ts:292`)与 composer 输出类型吻合,`#applyAgentSystemPrompt` 链不动。
- `agent-session.ts:1178` / `4439`(get/setSystemPrompt)不动,composer 输出仍是 `string[]`。
- SYSTEM.md / appendPrompt 保持模板内数据,与 mode 区块无冲突(mode 区块是独立数组元素)。

## 6. 应用时机

### v1:会话创建(零新增路径)

`session.create` params 增 `modeId?: string`(缺省 = 默认 mode 或 none):
1. **模型**:`modelId` 优先级 = 显式传参 > `mode.modelRole` 解析(`settings.modelRoles[role]`,缺省回退现有默认 = modelRoles.default / ModelSelector 现有语义)> 无 mode
2. 工具集组装:展开后的 `extensions` 白名单过滤(未在名单的扩展**不加载**,与 disabledExtensions 语义对齐,后者最后生效;`[]` 显式空 = 仅内置核心工具)
3. 提示词:composer.compose(base, mode + user sections)(§5)
4. settings:全局基线 + mode 覆盖(冲突用户赢)

### v2:会话中热切换

`session.setMode(modeId, { hot: true })`:
1. **启用方向**:`ExtensionRunner.loadExtension(path)` 新增(§1.2)—— 对"新 mode 白名单里有、当前会话未加载"的扩展逐个加载;复用 P5 loader 的发现/缓存失效
2. **禁用方向**:已有 `removeExtensionTools` + `SessionTools.removeExtensionTools`
3. 提示词增量:§5.6(removeBySource → add → compose → setSystemPrompt)
4. **模型**:新旧 mode 的 `modelRole` 不同 → `setModelWithProviderSessionReset`(已有会话级切模型;忙会话同样门控)
5. settings 热载(daemon 侧会话级 settings 已有动态机制)
6. 忙会话门控:复用 P5 语义(isStreaming → pending,agent_end 补做)

## 7. RPC 契约

daemon 级(设置页用):
- `modes.list` → `[{ id, label, description, extends, extensions, hasPrompt, promptComplete, settingsKeys }]`
- `modes.save { id, label, description, extends, extensions, prompt, promptComplete, settings }`(校验:环/悬空引用/非法扩展 id/非法 section name/order → error)
- `modes.validate { id }` → `{ valid: true } | { valid: false, errors: string[] }`:复用 save 的校验纯函数(§4),供 **agent 自检** —— 模型用现有工具改预设文件后调用,不落盘只校验
- `modes.delete { id }`(引用该 id 的预设先报错)

会话级:
- `session.create` 增 `modeId`
- `session.setMode { modeId, hot?: boolean }`(v2)

> `modes.validate` 的 agent 工具形态(v2):注册为内置工具或 slash command(`/modes validate <id>`),v1 先以 daemon RPC 形态供设置页/脚本调用。

## 8. GUI 接入点

- **设置页**:Extensions tab 旁「预设」区块(或独立 tab)。组件 `ModesCenter`(仿 ExtensionsCenter 事件订阅模式,订阅 `modes.changed` 即时刷新)。编辑页:扩展多选(组合预设显示继承来源行 + 可勾选子预设)+ 提示词区块编辑器(section 列表:文本 + order + 删除;`promptComplete` 开关)+ settings 键值编辑 + 校验报错(环/悬空引用/重名 name)。
- **输入框**:欢迎页(hero)`WelcomeComposer` 项目行旁 mode chip(DSH `conversation.hero.agentPreset` 对齐)—— 选择随 create RPC 应用新会话;**会话态只读预设标签**(DSH `AgentPresetLabel` 对齐,无选择交互)。复用已修三态模式(welcome 空态 = 默认 mode;不继承)。**会话元数据存 `modeId`**(daemon 会话快照/激活链),历史会话重开 label 正确显示已应用的 mode;无 mode 的旧会话不显示。注意:welcome 空态输入框是独立 `WelcomeComposer`(非 `Composer`),chip 必须加在项目行(`gui-project-row`)。
- **i18n**:settings 域新增 `modes.*` keys(含 promptComplete 开关文案、继承来源行、校验错误文案;zh-CN/en 同步,遵循现有 12 域结构 + tLoose)。
- **扩展 API**:v1 **不引入** registerMode/registerPrompt(范围控制);v2 候选(§5.5)。

## 9. 与 P5 HMR 交互

- mode 展开缓存失效 = P5 entryMtimes 同模式(mtime 对比,扩展入口变更触发 reload 后重新展开白名单)
- v2 热切复用 P5 的忙闲门控 + `extensions.reloaded` 事件通知 GUI;新增 `modes.changed`(mode 文件保存广播,仿 `extensions.changed` 事件链)
- v2 扩展 reload 时 prompt 区块按 source 清理重挂(§5.5),与扩展 HMR 生命周期一致

## 10. 验证

- **单测(纯逻辑)**:
  - `modes/resolve.test.ts`:拓扑序、环抛错、悬空引用抛错、并集去重、settings 冲突用户赢、mtime 缓存失效
  - `prompts/composer.test.ts`:order 插槽排序(25/100/200/300 边界)、同名覆盖(子胜父/用户胜 mode)、`promptComplete` 整体替换、`removeBySource` 增量卸载、**无注入时 compose(base) === base 原样**(回归锚)
  - string 快捷语法 → section 展开
- **v1 E2E**:隔离 daemon + `session.create { modeId: "design" }` → 断言:不在白名单的工具不可调;`systemPrompt` 含 mode 区块且位于主模板与 safety 之间(按 order);覆盖 settings 生效;用户禁用/用户 prompt 区块仍生效;`promptComplete: true` 预设替换继承链 prompt;`runtimeContext: false` 预设无 activeRepoContext 区块;会话 modeId 持久化(重开恢复,chip 显示正确)
- **modes.validate**:损坏预设(环/悬空引用/非法扩展 id)→ `{ valid: false, errors: [...] }`;合法预设 → `{ valid: true }`(复用 save 校验,单源)
- **v2 单测**:`ExtensionRunner.loadExtension`(目录加载 + 工具注册 + 幂等);composer 热切换增量(remove→add→compose 输出正确);热切 E2E 为 v2 验收

## 11. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| 1 | `extends` 独立字段,不混入 `extensions` | 预设名 vs 扩展 id 无命名空间,数组内字符串不可区分 |
| 2 | **prompt 默认追加(共存)语义,`promptComplete: true` 提供完整替换** | 追加参考 DSH section 共存(组合预设 = 多角色区块并存,衍生预设保留父 persona);完整替换参考 DSH persona `complete: true`(§2.5)—— 极简/固定 persona 的逃生门,composer 忽略内置区块与继承链 |
| 3 | 用户全局显式值最后生效 | 参考 DSH profile 层 > bundle 层;防预设复活被禁扩展 |
| 4 | v1 不引入 registerMode/registerPrompt | 范围控制;mode 是数据抽象,扩展 API 是 v2 增强 |
| 5 | modes 全局存放(`~/.musepi/modes/`) | Work/Design 是跨项目角色预设,非目录级 profile |
| 6 | **v1 即落地 PromptComposer(section 模型),但只做数组级注入,不重构 handlebars 模板** | 模板内拆分(personality/contextFiles 区块化)改动大、风险高;数组级注入覆盖 mode/用户/扩展三类贡献方,模板重构留 v2 后 |
| 7 | **用户全局 `prompt.sections`(settings)v1 引入** | DSH 用户 patch 层的轻量提示词对应物;不依赖 mode 也能自定义提示词 |
| 8 | 热切换沿用会话初始 base(main template),mode 只动注入层 | 模板/contextFiles 本就按会话快照,重跑 base 徒增成本且引入不一致 |
| 9 | **mode 带可选 `modelRole`,只做创建时默认档位,不复制模型列表** | musepi 已有完整档位机制(settings.modelRoles + model-resolver 内置角色 fast/small/slow);"Cheap & Fast / Creative" 就是两个 modelRole + 提示词/工具组合,模型解析零新增 |
| 10 | **extensions 三态:缺省=全部 / `[]`=仅内置核心 / 显式数组=白名单** | 轻量模式的精简工具集必须有"显式空"表达;编辑页三态开关(全部/仅核心/自定义)防误设 |
| 11 | **mode 是内容层预设,不承载形态层(执行形态)** | DSH 的"极简"实为 headless profile(一次性任务、无 Web/Host/浏览器、禁用 HMR)—— 形态层;musepi 已有对应物(headless modes:print/RPC/ACP/subagents + `$env.NULL_PROMPT` 极简提示词)。headless 是 CLI 启动形态,与 GUI 会话预设(mode)正交,塞进 mode 数据会造成两个维度纠缠 |
| 12 | **内置模板 work + chat + design + creator(DSH 四预设参考:work≈standard、chat≈minimal、creator≈cordis、design 为 musepi 独有)** | DSH 四预设中 code(Code Mode SDK)在 musepi 无对应能力,不内置;work(= 默认全量,无 mode 时行为)与 chat(= `[]` 扩展 + promptComplete + 关压缩)真实可用;design(设计 persona)与 creator(创作 persona,引导 musepi-extension-dev)为提示词预设。Creator 创作入口 = 设置页预设编辑器,不引入 cordis 工具集 |
| 13 | **运行时态以文件+reload 等价覆盖;不引入 cordis_mount;dryRun 不做除非隔离评估;inspect 为 v2 候选** | §2.6:musepi 扩展态 = 文件态,试验/挂载/评估 = write→reload→执行,零额外特权且可审计。dryRun 的"临时 registry"仍会在进程内 import,顶层副作用照常执行,预览语义击穿;务实安全网 = 错误隔离 + 文件回滚。inspect 低成本(信息已在 runner),补创作反馈环 |
| 14 | **`modes.validate` 复用校验纯函数,先 RPC 后 agent 工具** | agent 改预设后自检闭环:model 用现有 write 工具改 JSON → `modes.validate` → 修错。不造新写路径,校验逻辑单源(resolve.ts 导出) |
| 15 | **extensions 并集 = 共存语义;`extensionsComplete` 逃生门当前不做** | 与 prompt 追加语义对齐;组合预设保留父扩展集。要"清空"→ 不 extends 自写;将来需要再仿 promptComplete 加键,避免现在造未用机制 |
| 16 | **`runtimeContext: false`(缺省 true)关闭 activeRepoContext 区块,继承链任一声明 false 即生效** | 参考 DSH minimal `includeRuntimeContext: false`;activeRepoContext 是 buildSystemPrompt 选项非 settings 键,故独立字段。极简意图优先(安全方向):关闭不被后声明覆盖 |

## 12. 实施拆分(若开工)

1. `modes/resolve.ts` + `prompts/composer.ts` + 双单测(纯逻辑,零依赖)
2. v1 集成:`session.create` modeId + 白名单过滤 + composer 注入 + settings 合并 + settings `prompt.sections` 键 + 单测
3. GUI:设置页 ModesCenter + 输入框 chip + i18n modes 域
4. daemon RPC:modes.list/save/delete + `modes.validate`(校验纯函数导出)+ `modes.changed` 事件链
5. v2:ExtensionRunner.loadExtension + session.setMode 热切 + registerPrompt(扩展贡献)+ `extensions.inspect` + modes.validate agent 工具形态(/modes validate)
