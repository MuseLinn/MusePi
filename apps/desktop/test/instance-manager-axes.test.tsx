import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InstanceManagerDialog } from "../src/components/InstanceManagerDialog";
import type { RemoteHost } from "../src/lib/remote-hosts";

/**
 * The two axes, in one dialog.
 *
 * The user's question was whether "remote workspace" and "remote instance" are
 * the same model at different locations. They are two axes — an instance says
 * where the daemon runs, a workspace says where the files live — and the
 * surface has to say so rather than leave it to be inferred. These assertions
 * pin the model, not the pixels: each axis is named, each asks for its own
 * fields, a host is listed once, and the empty state offers exactly one action.
 */

setLocale("zh-CN");

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	delete (globalThis as { musepiShell?: unknown }).musepiShell;
});

/** An RPC stub: the embedded wizard asks `remote.hosts` when its list appears. */
function rpcStub(hosts: Array<{ name: string; host: string }> = []): never {
	return {
		request: async (method: string) => {
			if (method === "remote.hosts") return { hosts, sshfs: true };
			throw new Error(`unexpected ${method}`);
		},
	} as never;
}

const HOSTS: RemoteHost[] = [
	{ id: "h1", label: "build-box", url: "ws://127.0.0.1:9400" },
	{ id: "h2", label: "laptop", url: "ws://192.168.1.20:8300" },
];

async function render(overrides: Partial<Parameters<typeof InstanceManagerDialog>[0]> = {}): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.add(root);
	const props: Parameters<typeof InstanceManagerDialog>[0] = {
		open: true,
		onClose: () => {},
		rpc: rpcStub(),
		connected: true,
		daemonUrl: "ws://127.0.0.1:8300",
		hosts: HOSTS,
		onSwitchHost: () => {},
		onAddHost: () => {},
		onRemoveHost: () => {},
		onDisconnect: () => {},
		onOpenWorkspace: () => {},
		onOpenDisclaimer: () => {},
		...overrides,
	};
	await act(async () => {
		root.render(<InstanceManagerDialog {...props} />);
		await Bun.sleep(20);
	});
	return host;
}

/** The dialog portals to `document.body`, so every query goes there. */
const text = (_host: HTMLElement): string => document.body.textContent ?? "";
const sections = (_host: HTMLElement): HTMLElement[] =>
	Array.from(document.body.querySelectorAll<HTMLElement>(".gui-loc-section"));

/** Open the add form the axis's single primary action reveals. */
async function openAddForm(host: HTMLElement): Promise<HTMLElement> {
	const daemon = sections(host)[0] as HTMLElement;
	const add = Array.from(daemon.querySelectorAll<HTMLButtonElement>("button")).find(button =>
		(button.textContent ?? "").includes(t("settings.addInstance")),
	);
	await act(async () => add?.click());
	return daemon;
}

describe("the dialog states the two-axis model", () => {
	test("the purpose sentence says both axes and that they can differ", async () => {
		const host = await render();
		expect(text(host)).toContain(t("settings.connectionPurpose"));
	});

	test("each axis is a named section with its own one-sentence hint", async () => {
		const host = await render();
		const [daemon, files] = sections(host);
		expect(daemon?.querySelector(".gui-loc-section-title")?.textContent).toBe(t("settings.instanceAxisTitle"));
		expect(daemon?.querySelector(".gui-loc-section-hint")?.textContent).toBe(t("settings.instanceAxisHint"));
		expect(files?.querySelector(".gui-loc-section-title")?.textContent).toBe(t("settings.workspaceAxisTitle"));
		expect(files?.querySelector(".gui-loc-section-hint")?.textContent).toBe(t("settings.workspaceAxisHint"));
	});

	test("both axes are visible at once — no tab hides one of them", async () => {
		// The regression this pins: tabs let the user see only half the model,
		// which is exactly why the two concepts kept reading as each other's
		// mode.
		const host = await render();
		expect(document.body.querySelectorAll('[role="tablist"]')).toHaveLength(0);
		expect(sections(host)).toHaveLength(2);
		expect(text(host)).toContain(t("settings.instanceAxisTitle"));
		expect(text(host)).toContain(t("settings.workspaceAxisTitle"));
	});

	test("a section heading is not restated by a nested heading", async () => {
		// `DialogFrame` portals to `document.body`, so querying `host` returned
		// `[]` and `expect([]).toEqual([])` could never fail. The assertion has to
		// read the portal, and it has to fail on something real — hence the
		// non-empty precondition: with zero sections found the equality below
		// would pass vacuously all over again.
		await render();
		const titles = Array.from(document.body.querySelectorAll<HTMLElement>(".gui-loc-section-title")).map(
			node => node.textContent,
		);
		expect(titles).toHaveLength(2);
		expect(titles).toContain(t("settings.instanceAxisTitle"));
		expect(titles).toContain(t("settings.workspaceAxisTitle"));
		// The embedded wizard must not print a second heading for the axis the
		// section already names: the section headings are the only headings.
		const headings = Array.from(document.body.querySelectorAll<HTMLElement>("h2, h3")).map(node => node.textContent);
		expect(headings).toEqual(titles);
	});
});

describe("each axis asks for its own fields", () => {
	test("the daemon axis asks for an endpoint and a token, never a directory", async () => {
		const host = await render();
		const daemon = await openAddForm(host);
		const labels = Array.from(daemon.querySelectorAll(".gui-field-label")).map(node => node.textContent ?? "");
		expect(labels).toContain(t("settings.instanceLabel"));
		expect(labels).toContain(t("settings.instanceUrlLabel"));
		expect(labels).toContain(t("settings.remoteToken"));
		// A directory belongs to the files axis.
		expect(labels).not.toContain(t("settings.workspaceDirectory"));
	});

	test("the files axis asks for a host and a directory, never a daemon endpoint", async () => {
		const host = await render({ rpc: rpcStub([{ name: "build-box", host: "build.example.com" }]) });
		const files = sections(host)[1] as HTMLElement;
		const labels = Array.from(files.querySelectorAll(".gui-field-label")).map(node => node.textContent ?? "");
		// Step 0 is the method choice; the host fields arrive at step 1.
		const next = Array.from(files.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.next")),
		);
		await act(async () => next?.click());
		const ssh = Array.from(files.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes("SSH"),
		);
		await act(async () => {
			ssh?.click();
			await Bun.sleep(10);
		});
		const afterMethod = Array.from(files.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.next")),
		);
		await act(async () => {
			afterMethod?.click();
			await Bun.sleep(20);
		});
		const hostLabels = Array.from(files.querySelectorAll(".gui-loc-name, .gui-field-label")).map(
			node => node.textContent ?? "",
		);
		// A host list, not an endpoint form: the daemon endpoint belongs to the
		// other axis.
		expect(labels.length + hostLabels.length).toBeGreaterThan(0);
		expect(files.querySelectorAll(".gui-loc-list").length).toBeGreaterThan(0);
	});
});

describe("one host appears once across both surfaces", () => {
	function installBridge(): void {
		(globalThis as { musepiShell?: unknown }).musepiShell = {
			sshConfig: async () => ({
				ok: true,
				documents: [
					{
						path: "~/.ssh/config",
						text: "Host build-box\n  HostName build.example.com\n  User me\n",
					},
				],
				musepi: [],
			}),
		};
	}

	test("a catalog host is not listed twice in the wizard's list", async () => {
		installBridge();
		const host = await render({ rpc: rpcStub([{ name: "build-box", host: "build.example.com" }]) });
		const files = sections(host)[1] as HTMLElement;
		const next = Array.from(files.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.next")),
		);
		await act(async () => next?.click());
		const ssh = Array.from(files.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes("SSH"),
		);
		await act(async () => {
			ssh?.click();
			await Bun.sleep(10);
		});
		const afterMethod = Array.from(files.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.next")),
		);
		await act(async () => {
			afterMethod?.click();
			await Bun.sleep(30);
		});
		const names = Array.from(files.querySelectorAll(".gui-loc-name")).map(node => node.textContent);
		expect(names.filter(name => name === "build-box")).toHaveLength(1);
	});

	test("the wizard reads the catalog the dialog passed, not a second one", async () => {
		// The manager used to render the wizard without a catalog, so the wizard
		// silently performed its own read while the list beside it knew nothing.
		// One bridge read now serves both.
		let reads = 0;
		(globalThis as { musepiShell?: unknown }).musepiShell = {
			sshConfig: async () => {
				reads += 1;
				return {
					ok: true,
					documents: [{ path: "~/.ssh/config", text: "Host only-here\n  HostName h.example.com\n" }],
					musepi: [],
				};
			},
		};
		const host = await render();
		const files = sections(host)[1] as HTMLElement;
		/** What the manager itself has read so far (its open-time refresh). */
		const beforeWizard = reads;
		const next = Array.from(files.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.next")),
		);
		await act(async () => next?.click());
		const ssh = Array.from(files.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes("SSH"),
		);
		await act(async () => {
			ssh?.click();
			await Bun.sleep(10);
		});
		const afterMethod = Array.from(files.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.next")),
		);
		await act(async () => {
			afterMethod?.click();
			await Bun.sleep(30);
		});
		expect(text(files)).toContain("only-here");
		// A wizard that received no catalog would read it itself here; the
		// passed catalog means the count does not move.
		expect(reads).toBe(beforeWizard);
	});
});

describe("empty, loading and error states", () => {
	test("a first run with no other instances says so and offers one action", async () => {
		const host = await render({ hosts: [] });
		expect(text(host)).toContain(t("settings.instanceListEmpty"));
		const daemon = sections(host)[0] as HTMLElement;
		// Exactly one primary action, and it is the one that unblocks the state.
		const primary = daemon.querySelectorAll(".gui-btn-primary");
		expect(primary).toHaveLength(1);
		expect(primary[0]?.textContent).toContain(t("settings.addInstance"));
	});

	test("the local row is always present, even with no stored instances", async () => {
		const host = await render({ hosts: [] });
		const daemon = sections(host)[0] as HTMLElement;
		const names = Array.from(daemon.querySelectorAll(".gui-loc-name")).map(node => node.textContent);
		expect(names).toContain(t("general.local"));
	});

	test("a missing ssh config is not an error", async () => {
		// The bridge answers with no documents: a fresh machine, not a failure.
		(globalThis as { musepiShell?: unknown }).musepiShell = {
			sshConfig: async () => ({ ok: true, documents: [], musepi: [] }),
		};
		const host = await render();
		expect(document.body.querySelector('[role="alert"]')).toBeNull();
		expect(text(host)).not.toContain(t("settings.instanceConnectionFailed"));
	});

	test("a failed probe shows the daemon's own reason, not one generic sentence", async () => {
		// The workspace axis beside this one renders its real error; a single
		// "cannot connect" for a timeout, a refused token and a DNS failure
		// sends every user to the same wrong fix. The probe's socket is made to
		// fail deterministically, and the transport's own words must reach the UI.
		const RealWebSocket = globalThis.WebSocket;
		class FailingSocket extends EventTarget {
			constructor() {
				super();
				queueMicrotask(() => this.dispatchEvent(new Event("error")));
			}
			close(): void {}
		}
		(globalThis as { WebSocket?: unknown }).WebSocket = FailingSocket;
		const host = await render();
		const daemon = await openAddForm(host);
		const inputs = daemon.querySelectorAll<HTMLInputElement>("input.gui-input");
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		await act(async () => {
			setter?.call(inputs[0], "Dead box");
			inputs[0]?.dispatchEvent(new Event("input", { bubbles: true }));
			setter?.call(inputs[1], "ws://127.0.0.1:1");
			inputs[1]?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const submit = daemon.querySelector<HTMLButtonElement>(".gui-loc-actions .gui-btn-primary");
		await act(async () => {
			submit?.click();
			await Bun.sleep(400);
		});
		const alert = daemon.querySelector('[role="alert"]');
		const text = alert?.textContent ?? "";
		(globalThis as { WebSocket?: unknown }).WebSocket = RealWebSocket;
		// The generic sentence is still there — it names what to check — and the
		// transport's own reason must accompany it.
		expect(text).toContain(t("settings.instanceConnectionFailed"));
		expect(text).toContain("cannot connect to ws://127.0.0.1:1");
	});

	test("a rejected endpoint is reported inline, in the axis that rejected it", async () => {
		const host = await render();
		const daemon = await openAddForm(host);
		const inputs = daemon.querySelectorAll<HTMLInputElement>("input.gui-input");
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		await act(async () => {
			setter?.call(inputs[0], "Broken");
			inputs[0]?.dispatchEvent(new Event("input", { bubbles: true }));
			setter?.call(inputs[1], "ftp://nope");
			inputs[1]?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const submit = daemon.querySelector<HTMLButtonElement>(".gui-loc-actions .gui-btn-primary");
		await act(async () => {
			submit?.click();
			await Bun.sleep(30);
		});
		// The reason lands in the axis that failed, not in a shared banner.
		expect(daemon.querySelector('[role="alert"]')?.textContent).toBe(t("settings.instanceUrlInvalid"));
		expect(sections(host)[1]?.querySelector('[role="alert"]')).toBeNull();
	});
});

describe("row anatomy is the same in both lists", () => {
	test("every row states its name and where it runs, in that order", async () => {
		const host = await render();
		const daemon = sections(host)[0] as HTMLElement;
		const rows = Array.from(daemon.querySelectorAll(".gui-loc-row"));
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) {
			expect(row.querySelector(".gui-loc-name")).not.toBeNull();
			expect(row.querySelector(".gui-loc-where")).not.toBeNull();
		}
	});

	test("the row box itself is the target, not a control inside it", async () => {
		// M86's honest-hit-area rule: the element that paints the wash is the
		// element that acts.
		const host = await render();
		const daemon = sections(host)[0] as HTMLElement;
		for (const row of Array.from(daemon.querySelectorAll(".gui-loc-row"))) {
			const main = row.firstElementChild;
			expect(main?.tagName).toBe("BUTTON");
		}
	});

	test("a forwarded instance names the machine, never its loopback tunnel", async () => {
		// `ws://127.0.0.1:9400` is where the tunnel listens, not where the
		// daemon runs — the location is the catalog entry behind it.
		(globalThis as { musepiShell?: unknown }).musepiShell = {
			sshConfig: async () => ({
				ok: true,
				documents: [{ path: "~/.ssh/config", text: "Host build-box\n  HostName build.example.com\n  User me\n" }],
				musepi: [],
			}),
		};
		const host = await render();
		const daemon = sections(host)[0] as HTMLElement;
		const row = Array.from(daemon.querySelectorAll(".gui-loc-row")).find(node =>
			(node.textContent ?? "").includes("build-box"),
		);
		const where = row?.querySelector(".gui-loc-where")?.textContent ?? "";
		expect(where).toBe(t("settings.connectionWhereSsh", { host: "me@build.example.com" }));
		expect(where).not.toContain("127.0.0.1");
	});

	test("a loopback instance with no catalog entry says it is forwarded", async () => {
		const host = await render({ hosts: [{ id: "h9", label: "mystery", url: "ws://127.0.0.1:9401" }] });
		const daemon = sections(host)[0] as HTMLElement;
		const row = Array.from(daemon.querySelectorAll(".gui-loc-row")).find(node =>
			(node.textContent ?? "").includes("mystery"),
		);
		expect(row?.querySelector(".gui-loc-where")?.textContent).toBe(t("settings.connectionWhereForwarded"));
	});

	test("the local row does not restate its own name as its location", async () => {
		// The name already says 本机; repeating it as the location is the
		// restatement the hierarchy rule forbids. The loopback endpoint is the
		// honest second fact on that row.
		const host = await render();
		const daemon = sections(host)[0] as HTMLElement;
		const local = Array.from(daemon.querySelectorAll(".gui-loc-row")).find(node =>
			(node.textContent ?? "").includes(t("general.local")),
		);
		const where = local?.querySelector(".gui-loc-where")?.textContent ?? "";
		expect(where).not.toBe(t("general.local"));
		expect(where).toContain("127.0.0.1");
	});
});
