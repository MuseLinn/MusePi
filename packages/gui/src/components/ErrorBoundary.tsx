import { t } from "@musepi/desktop-web";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
	error: Error | null;
}

/**
 * App-level error boundary (sleep/wake freeze fix, 2026-08-20).
 *
 * An uncaught error during a render with NO boundary unmounts the React
 * root — the window keeps showing its last frame, console stays alive, CPU
 * idles, but every click is dead. That is exactly the "主界面卡死无响应"
 * symptom reported after lid-close/wake, where the reconnect restore render
 * can hit data the crashed window never validated. Catch it here and offer
 * a recovery action (full reload → boot → reconnect) instead of a dead page.
 *
 * Widget-level boundaries exist for extension cards; this one covers the
 * whole app shell.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
	override state: ErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("[gui] ErrorBoundary caught:", error, info.componentStack);
	}

	override render(): ReactNode {
		if (this.state.error !== null) {
			return (
				<div className="gui-shell">
					<div className="gui-connect-wrap">
						<div className="gui-brand">
							<span className="gui-brand-mark">π</span> MusePi
						</div>
						<p className="gui-connect-sub">{t("interface render error — reconnecting will recover")}</p>
						<button className="gui-btn gui-btn-primary" type="button" onClick={() => window.location.reload()}>
							{t("retry")}
						</button>
					</div>
				</div>
			);
		}
		return this.props.children;
	}
}
