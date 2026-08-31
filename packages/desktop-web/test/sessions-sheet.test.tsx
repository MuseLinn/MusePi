import { afterAll, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceSessionInfo } from "@musepi/pi-wire";
import { SessionsSheet } from "../src/components/shell/SessionsSheet";

// The closing-stage assertions below need a real effect-driven render
// (bun:test has no DOM), so register happy-dom globally for this file.
GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	GlobalRegistrator.unregister();
});

const SESSIONS: WorkspaceSessionInfo[] = [
	{
		id: "s1",
		title: "Session one",
		cwd: "/work",
		messageCount: 3,
		working: false,
		paused: false,
		live: true,
		updatedAt: 1_751_791_200_000,
	},
];

function render(open: boolean): string {
	return renderToStaticMarkup(
		<SessionsSheet sessions={SESSIONS} currentId="s1" onSelect={() => {}} open={open} onClose={() => {}} />,
	);
}

describe("SessionsSheet always-mounted close path", () => {
	it("renders the frosted card and backdrop while open", () => {
		const html = render(true);
		expect(html).toContain("ss-backdrop");
		expect(html).toContain("ss-card");
		expect(html).toContain("Session one");
	});

	it("open sheet renders without the closing marker (SSR initial stage)", () => {
		const open = render(true);
		expect(open).toContain("ss-backdrop");
		expect(open).not.toContain("ss-closing");
	});

	it("closing stage puts ss-closing on the card itself (exit animation wired)", async () => {
		// Regression: the card's className was static, so `.ss-card.ss-closing`
		// never matched and the 280ms ss-card-out animation never ran — the
		// card sat frozen until the fallback timer hid it. The closing class
		// must reach the card element when the open prop flips false.
		const div = document.createElement("div");
		document.body.appendChild(div);
		let root: ReturnType<typeof createRoot> | null = null;
		const renderWith = async (open: boolean): Promise<void> => {
			await act(async () => {
				root?.render(
					createElement(SessionsSheet, {
						sessions: SESSIONS,
						currentId: "s1",
						onSelect: () => {},
						open,
						onClose: () => {},
					}),
				);
			});
		};
		try {
			await act(async () => {
				root = createRoot(div);
			});
			await renderWith(true);
			expect(div.querySelector(".ss-card")?.className).not.toContain("ss-closing");
			await renderWith(false);
			const card = div.querySelector(".ss-card");
			expect(card).not.toBeNull();
			expect(card?.className).toContain("ss-closing");
		} finally {
			await act(async () => {
				root?.unmount();
			});
			div.remove();
		}
	});

	it("unmounts fully once closed (hidden stage) — no card in the DOM", () => {
		const html = render(false);
		expect(html).not.toContain("ss-card");
	});
});
