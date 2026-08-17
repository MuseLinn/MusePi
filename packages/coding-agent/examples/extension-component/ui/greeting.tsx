/**
 * Renderer-side component contributed by the extension-component example.
 * Compiled by the daemon (bun.build, classic JSX) and dynamically imported
 * by the GUI's slot host.
 *
 * Component contract:
 * - default-export a React component
 * - reference React through the `React` identifier (the daemon rewrites it
 *   to window.MusePiReact at compile time) — never `import ... from "react"`,
 *   or the module would bind to a second react copy and break hooks
 * - type-only imports are fine (erased at compile)
 */
import type { ReactNode } from "react";

const { useState } = React;

export default function GreetingCard(): ReactNode {
	const [clicks, setClicks] = useState(0);
	return (
		<div
			style={{
				marginTop: 14,
				padding: "12px 14px",
				border: "1px solid var(--border, #2a2f3a)",
				borderRadius: 12,
				background: "var(--bg-raised, #1b1f27)",
			}}
		>
			<div style={{ fontSize: 13, fontWeight: 650, color: "var(--fg, #e6e9ef)" }}>扩展组件示例</div>
			<div style={{ fontSize: 12, color: "var(--fg-muted, #9aa3b2)", marginTop: 4 }}>
				这个卡片由扩展 <code>extension-component</code> 通过 <code>pi.registerComponent</code>
				注册到 settings.extensions 插槽,由设置页动态挂载。启用/禁用扩展后 10 秒内即时生效,
				无需重启。
			</div>
			<button
				type="button"
				onClick={() => setClicks(c => c + 1)}
				style={{
					marginTop: 10,
					padding: "5px 12px",
					borderRadius: 8,
					border: "none",
					background: "color-mix(in oklab, var(--accent, #34d399) 20%, transparent)",
					color: "var(--fg, #e6e9ef)",
					fontSize: 12,
					cursor: "pointer",
				}}
			>
				点了我 {clicks} 次
			</button>
		</div>
	);
}
