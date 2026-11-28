/**
 * L2 宿主服务层公共类型（P1 服务抽取）。
 *
 * 设计约束见 `docs/review/0.5.0-m2-daemon-host-layering.md`：
 * L2 是纯 TS、零 cordis 依赖的服务注册表；cordis 试点（M2-2.9）成功后
 * 服务逐个迁移为 cordis Service（ctx.<key> 与本 key 同名），注册表退化
 * 为兼容垫片。因此 key 命名即未来 ctx 服务键，不得随意更改。
 *
 * 能力缝纪律（roadmap M2-2.4）：每个 DaemonService 实现的头注释必须
 * 声明自己的接缝——输入（RPC 路由/事件）、输出（返回值/广播）、
 * 生命周期（start/stop 的副作用与可逆性）。
 */
import type { Context } from "@deepseek-ai/cordis";

export interface DaemonService {
	/** 稳定服务键（未来 cordis 化的 ctx.<key>）。 */
	readonly key: string;

	/** 本服务认领的 RPC 路由：route → 方法名。注册表聚合成路由表，
	 * 路由覆盖快照测试据此强制"每个 case 必须归属某服务或 legacy 清单"。 */
	readonly routes?: Readonly<Record<string, string>>;

	/** 依赖的 L2 服务键。
	 *
	 *  cordis 只在**声明过 inject** 的插件里允许属性访问 `ctx.<key>`：未声明就
	 *  读会抛 `cannot get property "x" without inject`（reflect.ts:152）。所以
	 *  依赖必须在这里列出，`mount` 会把它转成插件的 inject，cordis 也据它排序。 */
	readonly inject?: readonly string[];

	/** 服务启动（无状态服务可不实现）。
	 *
	 *  收到宿主 cordis Context，因此依赖按
	 *  `static inject` 语义在这里直接读——`ctx.sessionProjections`，属性访问，
	 *  不是另包一层取值函数。解析不到的依赖应当抛出：挂载会以
	 *  DaemonServiceMountError 失败，而不是让服务在缺依赖的状态下静默跑起来。 */
	start?(ctx: Context): Promise<void> | void;

	/** 服务停止：反向卸载 start/构造的全部副作用（cordis effect 语义
	 * 等价物），供未来热重载与 orderly shutdown 使用。 */
	stop?(): Promise<void> | void;
}
