import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConnectDialog } from "../src/components/ConnectDialog";

/**
 * The workspace wizard reading the same catalog as the instance form.
 *
 * The wizard is a renderer too, so it cannot touch the filesystem: the catalog
 * arrives through the shell bridge. What matters is that a host only
 * `~/.ssh/config` knows about is *listed* here — the review's finding was that
 * the parser had no consumer, so the gap stayed open.
 */

setLocale("zh-CN");

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	delete (globalThis as { musepiShell?: unknown }).musepiShell;
});

/** A bridge that answers with one MusePi host and one ssh-config-only host. */
function installBridge(): void {
	(globalThis as { musepiShell?: unknown }).musepiShell = {
		sshConfig: async () => ({
			ok: true,
			documents: [
				{
					path: "~/.ssh/config",
					text: "Host from-ssh-config\n  HostName cfg.example.com\n  User me\n  Port 2222\n",
				},
			],
			musepi: [{ name: "managed-box", host: "managed.example.com" }],
		}),
	};
}

/** A minimal RPC stub: only `remote.hosts` is asked during step 1. */
const rpc = {
	request: async (method: string) => {
		if (method === "remote.hosts") {
			return { hosts: [{ name: "managed-box", host: "managed.example.com" }], sshfs: true };
		}
		throw new Error(`unexpected ${method}`);
	},
} as never;

async function renderAtHostStep(): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.add(root);
	await act(async () => {
		root.render(<ConnectDialog open onClose={() => {}} rpc={rpc} onOpenWorkspace={() => {}} framed={false} />);
	});
	// Step 0 → 1 (the SSH card, then 下一步).
	const sshCard = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
		(button.textContent ?? "").includes("SSH"),
	);
	await act(async () => sshCard?.click());
	const next = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
		(button.textContent ?? "").includes(t("settings.next")),
	);
	await act(async () => {
		next?.click();
		await Bun.sleep(20);
	});
	return host;
}

describe("workspace wizard host catalog", () => {
	test("an ssh-config-only host is listed beside the daemon's own hosts", async () => {
		installBridge();
		const host = await renderAtHostStep();
		const text = host.textContent ?? "";
		expect(text).toContain("managed-box");
		// The finding in one assertion: a host only ~/.ssh/config knows about is
		// visible in the wizard, not just in the instance form.
		expect(text).toContain("from-ssh-config");
	});

	test("the daemon's own entry is not duplicated by the catalog", async () => {
		installBridge();
		const host = await renderAtHostStep();
		const rows = Array.from(host.querySelectorAll("button")).filter(button =>
			(button.textContent ?? "").includes("managed-box"),
		);
		expect(rows).toHaveLength(1);
	});

	test("without a bridge the daemon's hosts still list", async () => {
		const host = await renderAtHostStep();
		expect(host.textContent ?? "").toContain("managed-box");
	});
});
