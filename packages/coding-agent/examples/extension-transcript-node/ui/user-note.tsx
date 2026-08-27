/**
 * Renderer-side component contributed by the extension-transcript-node
 * example. Compiled by the daemon (bun.build, classic JSX) and dynamically
 * imported by the GUI's transcript node seat.
 *
 * Component contract:
 * - default-export a React component
 * - reference React through the `React` identifier (the daemon rewrites it
 *   to window.MusePiReact at compile time) — never `import ... from "react"`
 * - receive the slot props: this seat passes `node` = { entry, kind, turnIndex?, children? }
 *   - `children` is the built-in MusePi rendering of the entry. A component
 *     that OWNS the kind can render it as a base (keep the official skeleton)
 *     or ignore it and render fully custom.
 */
import type { ReactNode } from "react";

/** Minimal seat prop shape (type-only import is erased at compile). */
interface NodeSeatProps {
	node?: {
		entry: unknown;
		kind: string;
		turnIndex?: number;
		children?: ReactNode;
	};
}

export default function UserNote({ node }: NodeSeatProps): ReactNode {
	if (!node) return null;
	return (
		<div
			style={{
				display: "block",
				border: "1px dashed var(--border, #2a2f3a)",
				borderRadius: 12,
				padding: "8px 12px",
				margin: "2px 0",
			}}
		>
			<div style={{ fontSize: 11, fontWeight: 650, color: "var(--accent, #34d399)", marginBottom: 4 }}>
				扩展笔记 · dispatch kind = {node.kind}
			</div>
			{/* The built-in user message is the base; this extension owns the
			 * node and augments it (keeps the official skeleton). */}
			{node.children}
		</div>
	);
}
