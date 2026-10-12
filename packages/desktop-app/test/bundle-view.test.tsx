/**
 * BundleView contract — the capability center's composition tab.
 *
 * The user-visible failure this surface exists to make visible is "I installed
 * a bundle and it contributes nothing". So the behaviours pinned here are the
 * ones that distinguish a healthy composition from a broken one:
 *
 * - A row's toggle reflects the RECOMPOSED state the daemon reports, not the
 *   request the click made.
 * - A `conditional` row gets no toggle at all — its enablement comes from an
 *   expression the host does not evaluate, so a switch that looks actionable
 *   would be a lie.
 * - A missing/disabled plugin is labelled on the row rather than silently
 *   absent.
 * - A profile that declares no composition is an explained empty state, not an
 *   error.
 */
import "./happy-dom-shim"; // MUST be first: component graphs define HTMLElement subclasses at evaluation time.
import { describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { BundleView } from "../src/components/BundleView";

/** Minimal rpc stub: records requests and answers from a routing table. */
function rpcStub(responses: Record<string, unknown>): {
	rpc: { request(method: string, params?: unknown): Promise<unknown>; addEventListener(): () => void };
	calls: Array<{ method: string; params?: unknown }>;
} {
	const calls: Array<{ method: string; params?: unknown }> = [];
	return {
		calls,
		rpc: {
			request(method: string, params?: unknown): Promise<unknown> {
				calls.push({ method, params });
				const answer = responses[method];
				if (answer === undefined) return Promise.reject(new Error(`unexpected ${method}`));
				return Promise.resolve(answer);
			},
			addEventListener: () => () => {},
		},
	};
}

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: "schedule",
	name: "@demo/plugin-schedule",
	state: "enabled",
	group: false,
	inject: [],
	layers: ["@demo/bundle"],
	pluginPath: "/plugins/node_modules/@demo/plugin-schedule",
	pluginIssue: null,
	mountable: true,
	...over,
});

const composition = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	profile: "desktop",
	declared: "ok",
	bundles: ["@demo/bundle"],
	layers: [{ name: "@demo/bundle", rows: 1, overrides: 0, unreadable: [] }],
	rows: [row()],
	conditionalRows: [],
	unevaluatedExpressions: 0,
	...over,
});

/**
 * Render the view and return its text content.
 *
 * The component fetches on mount, so the assertion runs after the promise
 * settles; the stub resolves synchronously enough for one microtask turn.
 */
async function renderToText(rpc: unknown): Promise<string> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(createElement(BundleView, { rpc: rpc as never }));
	});
	const text = host.textContent ?? "";
	await act(async () => {
		root.unmount();
	});
	host.remove();
	return text;
}

/**
 * Render and hand back the host plus a synchronous teardown.
 *
 * The teardown is returned rather than scheduled: a fire-and-forget `act`
 * unmounts the tree while the next assertion is still running against it.
 */
async function renderToHost(rpc: unknown): Promise<{ host: HTMLElement; cleanup(): Promise<void> }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(createElement(BundleView, { rpc: rpc as never }));
	});
	return {
		host,
		cleanup: async () => {
			await act(async () => {
				root.unmount();
			});
			host.remove();
		},
	};
}

describe("BundleView", () => {
	it("names the composed rows it was given", async () => {
		const { rpc } = rpcStub({ "bundles.composition": composition() });

		const text = await renderToText(rpc);

		expect(text).toContain("schedule");
		expect(text).toContain("@demo/plugin-schedule");
	});

	it("explains a profile that declares no composition instead of showing an error", async () => {
		const { rpc } = rpcStub({
			"bundles.composition": composition({ declared: "no-manifest", bundles: [], layers: [], rows: [] }),
		});

		const text = await renderToText(rpc);

		// The empty state names what a profile would do to declare one, so the
		// tab is not a dead end.
		expect(text).toContain("dsh.profile.bundles");
	});

	it("reports unevaluated expressions rather than hiding the rows they gate", async () => {
		const { rpc } = rpcStub({
			"bundles.composition": composition({
				rows: [row({ id: "win-only", state: "conditional" })],
				conditionalRows: ["win-only"],
				unevaluatedExpressions: 3,
			}),
		});

		const text = await renderToText(rpc);

		expect(text).toContain("win-only");
		expect(text).toContain("3");
	});

	it("labels a row whose plugin is not installed", async () => {
		const { rpc } = rpcStub({
			"bundles.composition": composition({
				rows: [row({ pluginPath: null, pluginIssue: "not-installed", mountable: false })],
			}),
		});

		const text = await renderToText(rpc);

		expect(text).toContain("schedule");
		expect(text).toMatch(/not installed|未安装/);
	});

	it("gives a toggle to an ordinary row but NOT to a conditional one", async () => {
		// A conditional row's enablement comes from an expression the host does
		// not evaluate. A switch there would look actionable and do nothing the
		// person expects — so the row is labelled instead of toggled.
		const { rpc } = rpcStub({
			"bundles.composition": composition({
				rows: [row({ id: "plain" }), row({ id: "win-only", state: "conditional" })],
				conditionalRows: ["win-only"],
				unevaluatedExpressions: 1,
			}),
		});

		const { host, cleanup } = await renderToHost(rpc);

		const switches = [...host.querySelectorAll('[role="switch"]')];
		// Exactly one toggle, for the plain row.
		expect(switches).toHaveLength(1);
		const toggledRow = switches[0]?.closest(".gui-ext-provider");
		expect(toggledRow?.textContent).toContain("plain");
		expect(toggledRow?.textContent).not.toContain("win-only");
		await cleanup();
	});

	it("sends the row id and the opposite state when a toggle is clicked", async () => {
		const { rpc, calls } = rpcStub({
			"bundles.composition": composition(),
			"bundles.rows.setEnabled": { ok: true, state: "disabled" },
		});

		const { host, cleanup } = await renderToHost(rpc);
		const toggle = host.querySelector('[role="switch"]');
		await act(async () => {
			toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		const write = calls.find(call => call.method === "bundles.rows.setEnabled");
		// The request asks for the OPPOSITE of the row's current state.
		expect(write?.params).toEqual({ id: "schedule", enabled: false });
		await cleanup();
	});
});
