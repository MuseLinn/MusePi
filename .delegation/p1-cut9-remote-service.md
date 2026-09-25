你是 MusePi 仓库（musepi-omp）的一名工程师。执行"P1 第九刀：RemoteService 抽取"——纯搬移式重构，不改任何行为。完成后只报告，不要 git commit / git push。

## 环境
- 仓库根：C:\Users\unive\projects\harness-engineering\musepi-omp（main 分支，工作树干净，HEAD = 71bdcc461）
- Git Bash。每个命令前先 `export PATH="/c/Users/unive/.bun/bin:$PATH"`
- 包目录：packages/coding-agent

## 背景（先读范本再动手）
daemon 宿主分层 P1 服务抽取：server.ts 巨型 switch 的路由逐个委托给 src/daemon/services/ 下的 L2 服务。已完成 8 刀。范本：
1. src/daemon/services/types.ts（DaemonService 接口）
2. src/daemon/services/browser-service.ts（上刀成果，形态与本刀几乎一样：薄委托 + 无宿主状态）
3. src/daemon/services/legacy-routes.ts 与 route-coverage.test.ts（清单与测试注册）

## 本刀范围
server.ts 巨型 switch 中 5 个 remote.* 路由（约 5724-5734 行，用内容搜索定位 `case "remote.hosts"`）：
- remote.hosts → listRemoteHosts()
- remote.hostAdd → addRemoteHost(params)
- remote.connect → connectRemoteHost(params)
- remote.browse → browseRemoteDir(params)
- remote.disconnect → disconnectRemoteHost(params)

五个函数全部已在 src/daemon/remote.ts 导出（listRemoteHosts/addRemoteHost/connectRemoteHost/browseRemoteDir/disconnectRemoteHost），server.ts 顶部静态 import 它们（约 153 行：`import { addRemoteHost, browseRemoteDir, connectRemoteHost, disconnectRemoteHost, listRemoteHosts } from "./remote";`）。领域逻辑不许动 remote.ts。

注意：这些路由 case 体极小（就是一行函数调用），委托后 server 的五个调用点与顶部 import 一并清理。

## 具体改动
1. 新建 src/daemon/services/remote-service.ts：
   - `export class RemoteService implements DaemonService`：key = "remote"；routes = { "remote.browse": "browse", "remote.connect": "connect", "remote.disconnect": "disconnect", "remote.hostAdd": "hostAdd", "remote.hosts": "hosts" } as const
   - 五个方法直接静态 import ../remote 的对应函数并转调（参数形状原样透传：看 server.ts case 里的 `as Parameters<...>` / `as { name?: unknown }` 断言怎么写，保持等价）
   - 本服务无宿主依赖、无状态——不需要 deps 注入接口
   - 头注释中文能力缝声明（输入/输出/生命周期）+ 范围边界，风格照抄 browser-service.ts
2. server.ts：
   - import { RemoteService } from "./services/remote-service"（字母序插入服务导入区，ApprovalService/BoardService/BrowserService 之后）
   - 构造函数注册区（BrowserService 注册之后）加 `this.#services.register(new RemoteService());`
   - 删掉顶部从 "./remote" 的静态 import 行（确认这五个标识符在 server.ts 里只剩这 5 个 case 在用——先 grep 全文件确认再删）
   - 5 个 case 体改为委托 + 一行中文注释，例如：
     ```ts
     case "remote.hosts": {
     	// 实现归 RemoteService（SSH 远程主机面语义不变）。
     	return this.#services.get<RemoteService>("remote").hosts();
     }
     ```
3. src/daemon/services/legacy-routes.ts：删除 5 条 remote.*（约 139-143 行）
4. src/daemon/services/route-coverage.test.ts：buildRegistry() 注册 `new RemoteService()`（无依赖）

## 验证（必须全绿）
```bash
export PATH="/c/Users/unive/.bun/bin:$PATH"
cd /c/Users/unive/projects/harness-engineering/musepi-omp/packages/coding-agent
bunx biome check --write src/daemon && bunx biome check src/daemon
bun test src/daemon test/daemon        # 期望 195 pass / 0 fail
cd ../.. && bun run check:ts           # 期望 0 处 error TS
```
若你的 Bash 工具被权限系统拒绝，在报告中明确声明"验证未执行"，不要假装跑过。

## 纪律
- 纯搬移不改行为；不碰 remote.ts、不动 docs；不改清单之外文件。
- 删 server.ts 顶部 import 前必须 grep 确认无其他使用点。
- 前提有假就停下来说明，不扩大范围。不要 commit / push。

## 报告格式
改动文件清单、验证输出摘要（或"验证未执行"声明）、与描述不符之处。
