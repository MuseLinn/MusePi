你是 MusePi 仓库（musepi-omp）的一名工程师。执行"P1 第七刀：ApprovalService 抽取"——这是一次纯搬移式重构，不改任何行为。完成后只报告，不要 git commit / git push。

## 环境
- 仓库根：C:\Users\unive\projects\harness-engineering\musepi-omp（main 分支，工作树干净）
- Git Bash 环境。每个命令前先 `export PATH="/c/Users/unive/.bun/bin:$PATH"`
- 包目录：packages/coding-agent

## 背景（先读这些文件再动手）
我们在做 daemon 宿主分层（P1 服务抽取）：把 packages/coding-agent/src/daemon/server.ts 巨型 switch 的路由逐个委托给 services/ 目录下的 L2 服务。已完成 6 刀（UsageService/EventService/ViewStoreService/BoardService/FileService/TerminalService），它们就是模式范本。

必读范本（模仿其结构与风格，包括中文能力缝头注释）：
1. packages/coding-agent/src/daemon/services/types.ts（DaemonService 接口：key/routes/start/stop）
2. packages/coding-agent/src/daemon/services/terminal-service.ts（依赖注入模式范本）
3. packages/coding-agent/src/daemon/services/view-store-service.ts（范围边界注释范本）
4. packages/coding-agent/src/daemon/server.ts 中 `case "usage.reports"` 与 `case "terminal.open"` 的委托写法

## 本刀范围（窄切口，只碰路由层）
server.ts 巨型 switch 中有三个审批路由（约 9592-9628 行，行号会变，用内容搜索定位）：
- `case "tool.approve"`：取参数 { sessionId, requestId, note? } → `this.#host.get(p.sessionId)`（无则抛 `Unknown session: ${p.sessionId}`）→ note trim（非空字符串才取 trim 后值，否则 undefined）→ `live.approvals.resolve(p.requestId, true, note)` 返回 false 则抛 `Unknown approval request: ${p.requestId}` → 返回 { ok: true }
- `case "tool.deny"`：同上但 resolve 第二参 false
- `case "session.askAnswer"`：参数 { sessionId, requestId, answer } → 同上取 live → `live.approvals.resolveAsk(p.requestId, p.answer ?? null)` 返回 false 则抛 `Unknown ask request: ${p.requestId}` → { ok: true }

**有意不碰（写进服务头注释的范围边界）**：ApprovalBridge 的创建（server.ts 约 1643 行 createApprovalBridge，在会话激活路径内，纠缠 live.subscribers/live.seq/setToolUIContext——属 session tree 契约，SessionService 阶段才动）；live.approvals.pendingAsks / pending 的只读消费点（subscribe 重放约 2862 行、tray.state 约 4105 行）原地保留。

## 具体改动
1. 新建 packages/coding-agent/src/daemon/services/approval-service.ts：
   - `export interface ApprovalServiceDeps { bridge(sessionId: string): ApprovalBridge | undefined }`（ApprovalBridge 类型从 ../approval-bridge 导入，类型导入即可）
   - `export class ApprovalService implements DaemonService`：key = "approvals"；routes = { "tool.approve": "approve", "tool.deny": "deny", "session.askAnswer": "askAnswer" } as const
   - 三个方法 approve/deny/askAnswer，参数为原始 params 对象（字段 unknown 化处理或直接沿用 case 里的类型断言风格——参考 terminal-service 的做法：方法签名用具体类型，调用处做 as 断言）。错误消息字符串必须与原来逐字一致（见上）。
   - 头注释风格照抄 view-store-service.ts：能力缝声明（输入/输出/生命周期）+ 范围边界（bridge 创建留宿主的理由）。
2. server.ts：
   - import { ApprovalService } from "./services/approval-service"（加在 FileService/TerminalService 导入附近，保持字母序区域整洁）
   - DaemonServer 构造函数注册区（`this.#services.register(new TerminalService(...))` 之后）加：
     ```ts
     this.#services.register(
     	new ApprovalService({
     		bridge: sessionId => host.get(sessionId)?.approvals,
     	}),
     );
     ```
     （注意注册区用的是构造参数 host，不是 this.#host；看 TerminalService 注册的上下文确认。）
   - 三个 case 体改为委托，各留一行中文注释说明实现归 ApprovalService，例如：
     ```ts
     case "tool.approve": {
     	// 实现归 ApprovalService（审批决议语义不变）。
     	return this.#services.get<ApprovalService>("approvals").approve(params ?? {});
     }
     ```
     params 的类型断言按服务方法签名来。
3. packages/coding-agent/src/daemon/services/legacy-routes.ts：删除三条 "session.askAnswer"（约 160 行）、"tool.approve"、"tool.deny"（约 244-245 行）。该文件是排序清单，删行即可。
4. packages/coding-agent/src/daemon/services/route-coverage.test.ts：在 buildRegistry() 里注册 ApprovalService，stub 依赖：`new ApprovalService({ bridge: () => undefined })`。

## 验证（必须全绿才算完成）
依次执行并确认：
```bash
export PATH="/c/Users/unive/.bun/bin:$PATH"
cd /c/Users/unive/projects/harness-engineering/musepi-omp/packages/coding-agent
bunx biome check --write src/daemon
bun test src/daemon test/daemon        # 期望 195 pass / 0 fail
cd ../.. && bun run check:ts           # 期望 0 处 error TS
```
注意：biome check --write 会修格式，跑完后再跑一次 `bunx biome check src/daemon` 确认干净。

## 纪律
- 纯搬移不改行为：不改错误消息、不改默认值、不改事件序、不改 RPC 命名/参数。
- 不碰 services/ 目录之外的任何既有逻辑（server.ts 只做 import/注册/三 case 委托/删旧 case 体四处改动；legacy-routes 只删三行；测试只加注册）。
- 不要 git commit，不要 git push，不要动 docs。
- 若验证失败，修到全绿为止；若发现本任务前提有假（比如某路由形态与描述不符），停下来在报告里说明，不要自行扩大范围。

## 报告格式
完成后报告：改动文件清单（含每个文件改了什么）、三处验证命令的输出摘要（测试 pass/fail 数、tsgo 错误数）、你发现的任何与上述描述不符之处。
