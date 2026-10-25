import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceSessionInfo } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkspaceView } from "../src/components/shell/WorkspaceView";
import type { SessionClient } from "../src/lib/client";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const SESSION: WorkspaceSessionInfo = {
	id: "session-1",
	title: "Session one",
	cwd: "/work",
	messageCount: 1,
	working: false,
	paused: false,
	live: true,
	updatedAt: 1,
};

const roots: Root[] = [];

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

function lastButton(selector: string): HTMLButtonElement {
	const buttons = document.querySelectorAll<HTMLButtonElement>(selector);
	const button = buttons[buttons.length - 1];
	if (!button) throw new Error(`no button matched ${selector}`);
	return button;
}

describe("WorkspaceView session deletion", () => {
	test("keeps a failed deletion retryable and closes only after a successful retry", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		let attempts = 0;
		try {
			const host = document.createElement("div");
			document.body.appendChild(host);
			const root = createRoot(host);
			roots.push(root);
			act(() =>
				root.render(
					<WorkspaceView
						client={{} as SessionClient}
						sessions={[SESSION]}
						onSelect={() => {}}
						onDeleteSession={() => {
							attempts++;
							return attempts === 1 ? Promise.reject(new Error("delete denied")) : Promise.resolve({ ok: true });
						}}
					/>,
				),
			);
			act(() => lastButton(".sh-ws-card-actions > button").click());
			const confirm = lastButton(".ss-card button");
			await act(async () => {
				confirm.click();
				await Bun.sleep(0);
			});

			expect(unhandled).toEqual([]);
			expect(document.querySelector(".ss-card") !== null).toBe(true);
			expect(document.querySelector('[role="alert"]')?.textContent).toBe("delete denied");
			expect(lastButton(".ss-card button").disabled).toBe(false);

			await act(async () => {
				lastButton(".ss-card button").click();
				await Bun.sleep(0);
			});
			expect(attempts).toBe(2);
			expect(document.querySelector(".ss-card") === null).toBe(true);
			expect(document.querySelector('[role="alert"]') === null).toBe(true);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
