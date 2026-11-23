/**
 * 会话信息卡「资源」分区（slot: `chat.session-info.resources`）— 插件自己的组件。
 *
 * 三行读数，每行「标签 / 细条 / 数值」：
 *
 * - **MusePi**：进程常驻内存 + 进程 CPU%；条长是常驻内存占整机内存的比例；
 * - **CPU**：整机 CPU%，条长直接用 0–100；
 * - **Memory**：整机已用 / 总量，条长是已用比例。
 *
 * 数据来自 `system.resources`（daemon 的 ResourcesService）。两个 CPU% 都是
 * 「距上一次采样」的差分，首次调用为 `null` —— 那时数值显示 `—`、条长留空，
 * 不显示 0%：0% 会被读成「刚测到空闲」，而事实是还没有基线。三行的格式规则
 * 在 `./resource-rows`，组件只负责画。
 *
 * 没有可用样本时（首次请求未回）整块不渲染 —— 分区没有空状态可画，卡片里留
 * 一个空边框比没有这个分区更糟。请求**失败**时保留上一份读数：2s 一次的轮询
 * 里，一次瞬时失败就把整块读卡闪掉，比读数短暂过期更糟；而读数过期会被下一
 * 次采样覆盖。轮询 2s、卸载即停，窗口不可见时整体跳过（回到前台立刻补一次）：
 * CPU% 的基线由服务端推进，采样节奏因此属于本组件，而不是共享的。
 *
 * 每行的悬停说明由 `./resource-rows` 生成：pid、堆、运行时长与核数放不进一行，
 * 但正是「这个数字是谁、在多核机器上怎么读」的答案。
 */

import { type ResourceSampleView, resourceRows } from "./resource-rows";
import "./resources-section.css";

// ── 平台面 ──────────────────────────────────────────────────────────────
// 宿主把此文件编译给 renderer，但在 daemon 工程内做类型检查（无 DOM lib）。
// 只声明用到的最小表面；组件通过 `React` 标识符取宿主的 React 实例
// （编译器 define: React → window.MusePiReact，绝不裸 import react）。

declare const React: {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
	useState: <T>(initial: T | (() => T)) => [T, (v: T | ((prev: T) => T)) => void];
	useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => void;
};

/** 宿主注入的语言环境（`slot-host.tsx` 的 `exposeHostReact`）。分区只读它
 *  来选标题：三行读数本身是语言中性的符号，没有别的文案要翻译。 */
declare const window: {
	MusePiI18n?: {
		readonly locale: string;
		subscribe(listener: () => void): () => void;
	};
};

declare const document: {
	readonly hidden: boolean;
	addEventListener(type: string, cb: () => void): void;
	removeEventListener(type: string, cb: () => void): void;
};

type ReactNode = unknown;

/** 分区标题。注册时给扩展中心看的 `label` 是插件身份，不是这张卡上的标题。 */
const TITLES: Record<string, string> = { "zh-CN": "资源", en: "Resources" };

function titleFor(locale: string): string {
	return TITLES[locale] ?? TITLES[locale.split("-")[0] ?? ""] ?? TITLES.en!;
}

interface SlotProps {
	rpc?: {
		request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
	} | null;
}

const POLL_INTERVAL_MS = 2000;

/** 条长：没有基线时留空。 */
function barWidth(percent: number | null): string {
	return percent === null ? "0%" : `${percent}%`;
}

function Row(props: { label: string; percent: number | null; value: string; title: string }): ReactNode {
	const { label, percent, value, title } = props;
	return React.createElement(
		"div",
		{ className: "mpres-row", title },
		React.createElement("span", { className: "mpres-label" }, label),
		// 条只是数值的可视化副本，屏幕阅读器读右侧数值即可。
		React.createElement(
			"span",
			{ className: "mpres-track", "aria-hidden": true },
			React.createElement("span", { className: "mpres-fill", style: { width: barWidth(percent) } }),
		),
		React.createElement("span", { className: "mpres-value" }, value),
	);
}

export default function ResourcesSection(props: SlotProps): ReactNode {
	const rpc = props.rpc ?? null;
	const [sample, setSample] = React.useState<ResourceSampleView | null>(null);
	const [locale, setLocale] = React.useState<string>(() => window.MusePiI18n?.locale ?? "zh-CN");

	// 标题跟随界面语言：宿主在切语言时广播，分区据此重渲染（三行读数本身
	// 不翻译，所以这里不需要注册自己的翻译命名空间）。
	React.useEffect(() => window.MusePiI18n?.subscribe(() => setLocale(window.MusePiI18n?.locale ?? "zh-CN")), []);

	React.useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const poll = (): void => {
			// 窗口不可见时不采样：2s 一次的空转在没有像素可更新时只是白烧 CPU，
			// 而 CPU% 的基线由服务端推进，跳过采样不会让下一次读数是错的。
			if (document.hidden) return;
			void rpc
				.request<ResourceSampleView | null>("system.resources")
				.then(next => {
					if (alive && next) setSample(next);
				})
				.catch(() => {
					// 瞬时失败保留上一份读数（下一次采样会覆盖它）；只有从未拿到
					// 样本时 `sample` 才是 null，那时整块不渲染。
				});
		};
		poll();
		const timer = setInterval(poll, POLL_INTERVAL_MS);
		// 回到前台立刻补一次，不等下一格轮询：否则窗口露出来后的两秒是上一份读数。
		const onVisible = (): void => {
			if (!document.hidden) poll();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			alive = false;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [rpc]);

	if (!sample) return null;
	return React.createElement(
		"section",
		{ className: "mpres-section" },
		React.createElement("div", { className: "mpres-title" }, titleFor(locale)),
		...resourceRows(sample).map(row =>
			React.createElement(Row, {
				key: row.label,
				label: row.label,
				percent: row.percent,
				value: row.value,
				title: row.title,
			}),
		),
	);
}
