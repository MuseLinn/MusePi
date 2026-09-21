import type { ReactNode } from "react";
import { Component, type ErrorInfo } from "react";

/**
 * Error boundary for widget rendering: a malformed data payload (or a
 * component bug) must never take down the whole transcript, board or pin
 * window — it degrades to a small inline note instead. Wraps the shared
 * registry components everywhere they render.
 */
export class WidgetErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };

	static getDerivedStateFromError(_error: Error): { failed: boolean } {
		return { failed: true };
	}

	override componentDidCatch(error: Error, _info: ErrorInfo): void {
		console.error("[widget] render failed:", error);
	}

	override render(): ReactNode {
		if (this.state.failed) {
			return <div className="tv-widget tv-widget-error">widget render failed · 组件渲染失败</div>;
		}
		return this.props.children;
	}
}
