你是 MusePi 仓库（musepi-omp）的一名工程师。执行"P1 第八刀：BrowserService 抽取"——纯搬移式重构，不改任何行为。完成后只报告，不要 git commit / git push。

## 环境
- 仓库根：C:\Users\unive\projects\harness-engineering\musepi-omp（main 分支，工作树干净，HEAD = e889ff022）
- Git Bash。每个命令前先 `export PATH="/c/Users/unive/.bun/bin:$PATH"`
- 包目录：packages/coding-agent

## 背景（先读范本再动手）
daemon 宿主分层 P1 服务抽取：server.ts 巨型 switch 的路由逐个委托给 src/daemon/services/ 下的 L2 服务。已完成 7 刀，范本：
1. src/daemon/services/types.ts（DaemonService 接口）
2. src/daemon/services/board-service.ts（无宿主状态、纯路由归属的范本——本刀形态与它最接近）
3. src/daemon/services/terminal-service.ts（依赖注入范本：settings 类依赖的注入方式）

## 本刀范围
server.ts 巨型 switch 中 10 个 browser.* 路由（约 4220-4262 行，用内容搜索定位 `case "browser.endpoint"` 等）：
- browser.endpoint / browser.tabs / browser.screenshot / browser.extensions / browser.importChrome / browser.clearCache / browser.clearAll：动态 import("./browser-rpc") 对应函数，前两个实参固定为 `await this.#settingsForRpc()` 和 `this.#host.cwd()`；browser.screenshot 多第三个实参 targetId（缺失时抛 `browser.screenshot requires targetId`）。
- browser.relayInstall / browser.relayStatus / browser.relayUninstall：无实参。

领域逻辑全部在 src/daemon/browser-rpc.ts（不许改动该文件），本刀只做路由归属层。

## 具体改动
1. 新建 src/daemon/services/browser-service.ts：
   - `export interface BrowserServiceDeps { settings(): Promise<Settings>; cwd(): string }`（Settings 类型从 ../../config/settings 类型导入，看 terminal-service.ts 的导入路径写法）
   - `export class BrowserService implements DaemonService`：key = "browser"；routes 认领全部 10 条（route 名 → 方法名，方法名自定但保持 routes 表与 case 委托一一对应）
   - 10 个方法：browser-rpc 的动态 import 移入服务内对应方法（保持懒加载语义，不要在服务文件顶层静态 import browser-rpc）；settings()/cwd() 走 deps；browser.screenshot 的 targetId 校验与错误消息逐字保留
   - 头注释中文能力缝声明 + 范围边界，风格照抄 board-service.ts
2. server.ts：
   - import { BrowserService } from "./services/browser-service"（字母序插入服务导入区）
   - 构造函数注册区（ApprovalService 注册之后）：
     ```ts
     this.#services.register(
     	new BrowserService({
     		settings: () => this.#settingsForRpc(),
     		cwd: () => host.cwd(),
     	}),
     );
     ```
     （看现有注册区用构造参数 host 还是 this.#host，与上下文一致即可）
   - 10 个 case 体改为单行委托 + 一行中文注释（如 `// 实现归 BrowserService（共享自动化 Chromium 语义不变）。`），删掉原 case 体内的实现
3. src/daemon/services/legacy-routes.ts：删除 10 条 browser.*（排序清单删行）
4. src/daemon/services/route-coverage.test.ts：buildRegistry() 注册 `new BrowserService({ settings: async () => ({ getRaw: () => undefined }) as never, cwd: () => "" })`（stub 够编译即可，方法不会被调用）

## 验证（必须全绿）
```bash
export PATH="/c/Users/unive/.bun/bin:$PATH"
cd /c/Users/unive/projects/harness-engineering/musepi-omp/packages/coding-agent
bunx biome check --write src/daemon && bunx biome check src/daemon
bun test src/daemon test/daemon        # 期望 195 pass / 0 fail
cd ../.. && bun run check:ts           # 期望 0 处 error TS
```
注意：你的 Bash 工具可能因权限无法执行——若被拒，在报告中明确说"验证未执行"，不要假装跑过。

## 纪律
- 纯搬移不改行为：错误消息、默认值、动态 import 懒加载、RPC 命名/参数全不变。
- 不碰 browser-rpc.ts、不碰会话生命周期、不动 docs。
- 不改本任务清单之外的任何文件。若前提有假（路由形态与描述不符），停下来说明，不扩大范围。
- 不要 git commit / push。

## 报告格式
改动文件清单、验证输出摘要（或"验证未执行"声明）、与描述不符之处。
