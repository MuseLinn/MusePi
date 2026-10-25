import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceSessionInfo } from "@musepi/pi-wire";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionsSheet } from "../src/components/shell/SessionsSheet";
import type { SessionClient } from "../src/lib/client";

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
		<SessionsSheet
			client={fakeClient()}
			sessions={SESSIONS}
			currentId="s1"
			onSelect={() => {}}
			open={open}
			onClose={() => {}}
		/>,
	);
}

/** Minimal SessionClient stand-in — swipe actions only ever call `rpc`. */
function fakeClient(): SessionClient {
	return {
		rpc: async () => ({ ok: true }),
	} as unknown as SessionClient;
}

describe("SessionsSheet always-mounted close path", () => {
	it("renders the open frosted card and backdrop without a closing marker", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		try {
			await act(async () => {
				root.render(
					<SessionsSheet
						client={fakeClient()}
						sessions={SESSIONS}
						currentId="s1"
						onSelect={() => {}}
						open
						onClose={() => {}}
					/>,
				);
			});
			expect(document.querySelector(".ss-backdrop")).not.toBeNull();
			expect(document.querySelector(".ss-card")?.className).not.toContain("ss-closing");
			expect(document.querySelector(".ss-card")?.textContent).toContain("Session one");
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});

	it("portals the fixed sheet out of a filtered header so it uses viewport geometry", async () => {
		const header = document.createElement("header");
		header.style.backdropFilter = "blur(1px)";
		document.body.appendChild(header);
		const root = createRoot(header);
		try {
			await act(async () => {
				root.render(
					<SessionsSheet
						client={fakeClient()}
						sessions={SESSIONS}
						currentId="s1"
						onSelect={() => {}}
						open
						onClose={() => {}}
					/>,
				);
			});
			const backdrop = document.querySelector(".ss-backdrop");
			expect(backdrop?.parentElement === document.body).toBe(true);
			expect(header.querySelector(".ss-backdrop")).toBeNull();
		} finally {
			await act(async () => root.unmount());
			header.remove();
		}
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
						client: fakeClient(),
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
			expect(document.querySelector(".ss-card")?.className).not.toContain("ss-closing");
			await renderWith(false);
			const card = document.querySelector(".ss-card");
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

	it("restores focus to the opener after the exit animation", async () => {
		const opener = document.createElement("button");
		document.body.appendChild(opener);
		opener.focus();
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const renderWith = async (open: boolean): Promise<void> => {
			await act(async () => {
				root.render(
					<SessionsSheet
						client={fakeClient()}
						sessions={SESSIONS}
						currentId="s1"
						onSelect={() => {}}
						open={open}
						onClose={() => {}}
					/>,
				);
			});
		};
		try {
			await renderWith(true);
			expect(document.activeElement).not.toBe(opener);
			await renderWith(false);
			await act(async () => Bun.sleep(320));
			expect(document.activeElement).toBe(opener);
		} finally {
			await act(async () => root.unmount());
			host.remove();
			opener.remove();
		}
	});

	it("claims Escape in capture without notifying keyboard handlers behind the sheet", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		let closeCount = 0;
		let backgroundCount = 0;
		const onBackgroundKey = (): void => {
			backgroundCount++;
		};
		window.addEventListener("keydown", onBackgroundKey);
		try {
			await act(async () => {
				root.render(
					<SessionsSheet
						client={fakeClient()}
						sessions={SESSIONS}
						currentId="s1"
						onSelect={() => {}}
						open
						onClose={() => closeCount++}
					/>,
				);
			});
			const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			await act(async () => {
				document.dispatchEvent(event);
			});

			expect(closeCount).toBe(1);
			expect(backgroundCount).toBe(0);
			expect(event.defaultPrevented).toBe(true);
		} finally {
			window.removeEventListener("keydown", onBackgroundKey);
			await act(async () => root.unmount());
			host.remove();
		}
	});

	it("keeps concealed swipe actions inert and out of the Tab order", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		try {
			await act(async () => {
				root.render(
					<SessionsSheet
						client={fakeClient()}
						sessions={SESSIONS}
						currentId="s1"
						onSelect={() => {}}
						open
						onClose={() => {}}
					/>,
				);
			});
			const actions = document.querySelector<HTMLElement>(".ss-swipe-actions");
			if (!actions) throw new Error("swipe actions did not render");

			expect(actions.getAttribute("aria-hidden")).toBe("true");
			expect(actions.inert).toBe(true);
			for (const button of Array.from(actions.querySelectorAll("button"))) {
				expect(button.tabIndex).toBe(-1);
			}
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});
});
