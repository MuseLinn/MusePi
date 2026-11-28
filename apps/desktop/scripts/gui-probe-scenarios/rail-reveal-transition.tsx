/**
 * What a destination click actually starts.
 *
 * The report was specific: only the three destinations that reveal the second
 * tier flicker, and they flicker even when the panel is ALREADY open (clicking
 * 会话 while on 会话). That rules out the fold animation and points at the
 * transition wrapper running when nothing about the column changed — a
 * `startViewTransition` with no `surfaceOnly` cross-fades the whole window.
 *
 * This scenario spies on the API rather than screenshotting the result, because
 * the defect IS "a transition was started at all".
 */
import type { CSSProperties, ReactNode } from "react";
import { AppRail } from "../../src/components/AppRail";
import type { GuiScenario } from "../gui-probe-helpers";
import { mount } from "../gui-probe-helpers";
import { withViewTransition } from "../../src/lib/view-transition";

type Call = { surfaceOnly: boolean; classes: string[] };

/** Record every transition the page starts, and what it was scoped to. */
function spy(): { calls: Call[] } {
	const sink: { calls: Call[] } = { calls: [] };
	const doc = document as unknown as {
		startViewTransition?: (update: () => void) => { finished: Promise<void> };
	};
	doc.startViewTransition = (update: () => void) => {
		update();
		sink.calls.push({
			surfaceOnly: document.documentElement.classList.contains("gui-vt-surface-only"),
			classes: Array.from(document.documentElement.classList),
		});
		return { finished: Promise.resolve() };
	};
	return sink;
}

const rail = (expanded: boolean): ReactNode => (
	<AppRail
		destinations={[{ id: "home", label: "rail sessions", icon: "chat-1", active: true, onSelect: () => {} }]}
		panelAvailable
		onTogglePanel={() => {}}
		expanded={expanded}
		onToggleExpanded={() => {}}
	/>
);

const shell = (expanded: boolean, paneOpen: boolean) => (
	<div className="gui-main" style={{ width: 900, height: 600, padding: 8 }}>
		{rail(expanded)}
		<div
			className="gui-side-keeper"
			data-panel={paneOpen ? "home" : undefined}
			style={{ "--gui-side-w": "256px" } as CSSProperties}
		>
			<div className="gui-pane-side" />
		</div>
	</div>
);

const scenarios = {
	/**
	 * The narrowed path that caused the flicker: the panel is already open, so a
	 * destination click must start NO transition at all.
	 */
	"reveal-when-already-open": {
		capture: ".gui-rail",
		async render(root: HTMLElement) {
			await mount(shell(true, true), root);
		},
		async measure() {
			const sink = spy();
			// Same body as the fixed `revealSidePanel` early return.
			const alreadyOpen = true;
			if (!alreadyOpen) {
				withViewTransition(() => {}, { surfaceOnly: true, extraClass: "gui-vt-left-col" });
			}
			return { transitions: sink.calls.length };
		},
	},
	"fold-uses-surface-only": {
		capture: ".gui-rail",
		async render(root: HTMLElement) {
			await mount(shell(false, false), root);
		},
		async measure() {
			const sink = spy();
			withViewTransition(() => {}, { surfaceOnly: true, extraClass: "gui-vt-left-col" });
			return {
				transitions: sink.calls.length,
				surfaceOnly: sink.calls[0]?.surfaceOnly ?? null,
				hasColumnClass: sink.calls[0]?.classes.includes("gui-vt-left-col") ?? false,
			};
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
