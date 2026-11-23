import type { ReactNode } from "react";

declare const React: {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => ReactNode;
};

interface ToolResult {
	content: ReadonlyArray<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

interface ToolRenderProps {
	args: Record<string, unknown>;
	result?: ToolResult;
}

const ACTION_LABELS: Record<string, string> = {
	devices: "列出设备",
	start: "启动模拟器",
	screenshot: "截图",
	tap: "点按",
	swipe: "滑动",
	key: "按键",
	text: "输入文本",
	ui_tree: "读取 UI 树",
	install: "安装 APK",
	launch: "启动应用",
	logcat: "读取日志",
};

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function actionSummary(args: Record<string, unknown>): string {
	const action = stringValue(args.action) ?? "devices";
	const label = ACTION_LABELS[action] ?? "操作设备";
	const target =
		action === "start"
			? stringValue(args.avd)
			: action === "install"
				? stringValue(args.apkPath)
				: action === "launch"
					? stringValue(args.component)
					: action === "key"
						? [stringValue(args.key), stringValue(args.device)].filter(Boolean).join(" · ")
						: stringValue(args.device);
	const coordinates =
		action === "tap" && typeof args.x === "number" && typeof args.y === "number" ? ` (${args.x}, ${args.y})` : "";
	return `${label}${target ? ` · ${target}` : ""}${coordinates}`;
}

export function Summary({ args }: ToolRenderProps): ReactNode {
	return <span>{actionSummary(args)}</span>;
}

export function Icon(): ReactNode {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
			<rect x="6" y="2" width="12" height="20" rx="3" />
			<path d="M10 5h4M11 18h2" strokeLinecap="round" />
		</svg>
	);
}

function DeviceList({ details }: { details: Record<string, unknown> }): ReactNode {
	const devices = Array.isArray(details.devices) ? details.devices : [];
	const avds = Array.isArray(details.avds) ? details.avds : [];
	return (
		<div style={{ display: "grid", gap: 6, padding: "4px 10px 10px", fontSize: 12 }}>
			{devices.map((value, index) => {
				const device = record(value);
				const id = stringValue(device?.id) ?? `设备 ${index + 1}`;
				const meta = [stringValue(device?.model), stringValue(device?.state)].filter(Boolean).join(" · ");
				return (
					<div key={id} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
						<span>{id}</span>
						<span style={{ opacity: 0.65 }}>{meta}</span>
					</div>
				);
			})}
			{avds.length > 0 ? <div style={{ opacity: 0.65 }}>可用 AVD：{avds.map(String).join("、")}</div> : null}
		</div>
	);
}

export function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = record(result?.details);
	if (details && args.action === "devices") return <DeviceList details={details} />;
	const text = (result?.content ?? [])
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("\n")
		.trim();
	if (!text) return null;
	return (
		<pre
			style={{
				margin: 0,
				padding: "4px 10px 10px",
				maxHeight: 280,
				overflow: "auto",
				whiteSpace: "pre-wrap",
				overflowWrap: "anywhere",
				fontSize: 11.5,
				color: result?.isError ? "var(--tv-err)" : "var(--tv-muted)",
			}}
		>
			{text}
		</pre>
	);
}

export default { label: "Android 模拟器", Icon, Summary, Body };
