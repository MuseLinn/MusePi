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

describe("the dialog manages instances, and only instances", () => {
	test("the lede names the one axis this dialog owns", async () => {
		const host = await render();
		expect(text(host)).toContain(t("settings.instanceAxisHint"));
	});

	test("a project's files are not chosen here", async () => {
		// Choosing where a project's files live belongs to 添加项目, which already
		// asks for a main directory. A second picker in this dialog offered two
		// answers to one question and pushed the instance list into half a pane.
		const host = await render();
		expect(text(host)).not.toContain(t("settings.workspaceAxisTitle"));
		expect(document.body.querySelectorAll(".gui-loc-section")).toHaveLength(1);
		// The four-step mount wizard is gone with it.
		expect(text(host)).not.toContain(t("settings.selectMethod"));
		expect(text(host)).not.toContain(t("settings.selectRemoteDirectoryOpen"));
	});

	test("the instance list is the whole surface — no tab hides part of it", async () => {
		const host = await render();
		expect(document.body.querySelectorAll('[role="tablist"]')).toHaveLength(0);
		expect(sections(host)).toHaveLength(1);
	});

	test("the dialog title is not restated by a section heading", async () => {
		// `DialogFrame` portals to `document.body`, so the assertion has to read
		// the portal. With one axis there is no section title left at all.
		await render();
		const titles = Array.from(document.body.querySelectorAll<HTMLElement>(".gui-loc-section-title"));
		expect(titles).toHaveLength(0);
		// A screen-reader-only h2 is the landmark's label, not a restated title.
		const visibleHeadings = Array.from(document.body.querySelectorAll<HTMLElement>("h2, h3"))
			.filter(node => !node.classList.contains("sr-only"))
			.map(node => node.textContent);
		expect(visibleHeadings).not.toContain(t("settings.instanceAxisTitle"));
	});
});

describe("the add form is the instance form", () => {
	test("it asks for an endpoint and a token, never a directory", async () => {
		const host = await render();
		const daemon = await openAddForm(host);
		const labels = Array.from(daemon.querySelectorAll(".gui-field-label")).map(node => node.textContent ?? "");
		expect(labels).toContain(t("settings.instanceLabel"));
		expect(labels).toContain(t("settings.instanceUrlLabel"));
		expect(labels).toContain(t("settings.remoteToken"));
		// A directory belongs to 添加项目, not to an instance.
		expect(labels).not.toContain(t("settings.workspaceDirectory"));
	});

	test("cancelling the form gives the section its add action back", async () => {
		// The form replaces the section's own 添加实例 button, so dismissing it
		// used to leave a section with neither: the form gone and the trigger
		// gone with it, and the only way to add a second instance was to close
		// and reopen the dialog.
		const host = await render();
		const daemon = await openAddForm(host);
		expect(daemon.querySelector(".gui-conn-form")).not.toBeNull();
		const cancel = Array.from(daemon.querySelectorAll<HTMLButtonElement>(".gui-conn-form-actions button")).find(
			button => (button.textContent ?? "").trim() === t("settings.cancel"),
		);
		await act(async () => {
			cancel?.click();
			await Bun.sleep(20);
		});
		expect(daemon.querySelector(".gui-conn-form")).toBeNull();
		const add = Array.from(daemon.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.addInstance")),
		);
		expect(add).toBeDefined();
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

	test("the shared form refuses an incomplete row in place, in the axis that owns it", async () => {
		// The instance axis now renders the same form the disconnected gate does,
		// so validation lives in one place. A missing label is refused before any
		// target is stored, and the sentence lands inside this axis.
		const host = await render();
		const daemon = await openAddForm(host);
		const submit = daemon.querySelector<HTMLButtonElement>(".gui-conn-form-actions .gui-btn-primary");
		await act(async () => {
			submit?.click();
			await Bun.sleep(30);
		});
		expect(daemon.querySelector(".gui-conn-error")?.textContent).toBe(t("settings.connectionLabelRequired"));
		// There is one surface now, so the sentence can only be here — and it must
		// not have leaked into the dialog-level footer either.
		expect(document.body.querySelectorAll(".gui-conn-error")).toHaveLength(1);
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
		const submit = daemon.querySelector<HTMLButtonElement>(".gui-conn-form-actions .gui-btn-primary");
		await act(async () => {
			submit?.click();
			await Bun.sleep(30);
		});
		// The reason lands on the row being added, not in a shared banner.
		expect(daemon.querySelector(".gui-conn-error")?.textContent).toBe(t("settings.instanceUrlInvalid"));
		expect(document.body.querySelectorAll(".gui-conn-error")).toHaveLength(1);
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
