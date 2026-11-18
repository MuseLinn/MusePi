import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ImportSessionsSetup } from "../src/components/ImportSessionsSetup";
import type { RpcClient } from "../src/lib/rpc";

// A scanned row describes the workspace the copy lands in. Some sources record
// a primary directory plus ordered reference roots; importing then grants read
// and write reach into all of them, so the row has to say so before the copy —
// it otherwise looks like a plain single-directory import.

const AGENTS = [{ source: "codex", name: "Codex" }];
const ROOTS = ["/tmp/reference", "/tmp/shared"];

function row(id: string, title: string, additionalDirectories?: string[]) {
	const now = new Date().toISOString();
	return {
		id,
		path: `/tmp/${id}.jsonl`,
		title,
		cwd: "/tmp/project",
		created: now,
		modified: now,
		messageCount: 2,
		firstMessage: title,
		...(additionalDirectories ? { additionalDirectories } : {}),
	};
}

const SOURCES = [
	{
		source: "codex",
		name: "Codex",
		count: 2,
		sessions: [row("multi", "Multi-root session", ROOTS), row("single", "Single-root session")],
	},
];

class FakeRpc {
	request<T>(method: string): Promise<T> {
		if (method === "import.agents") return Promise.resolve(AGENTS as T);
		if (method === "import.sources") return Promise.resolve(SOURCES as T);
		return Promise.resolve({} as T);
	}
}

let root: Root;
let host: HTMLDivElement;
let previousLocale: ReturnType<typeof getLocaleSnapshot>;

beforeEach(() => {
	previousLocale = getLocaleSnapshot();
	setLocale("en-US");
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	setLocale(previousLocale);
});

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

/** Pick the only source, scan, and wait for the grouped session list. */
async function mountAllSessions(): Promise<void> {
	act(() => {
		root.render(<ImportSessionsSetup rpc={new FakeRpc() as unknown as RpcClient} />);
	});
	await flush();
	act(() => host.querySelector<HTMLElement>(".gui-import-source")?.click());
	const scanButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item =>
		item.textContent?.includes("Scan"),
	);
	act(() => scanButton?.click());
	await flush();
}

/** One session row, found by its visible title. */
function sessionRow(title: string): HTMLElement {
	const match = [...host.querySelectorAll<HTMLElement>(".gui-import-session")].find(
		item => item.querySelector(".gui-import-session-title")?.textContent === title,
	);
	if (!match) throw new Error(`Missing session row: ${title}`);
	return match;
}

function rootsHint(rowElement: HTMLElement): HTMLElement | null {
	return rowElement.querySelector<HTMLElement>(".gui-import-roots");
}

describe("import session reference roots", () => {
	test("states how many directories the import will add beside the primary one", async () => {
		await mountAllSessions();

		const hint = rootsHint(sessionRow("Multi-root session"));
		expect(hint?.textContent).toBe("Adds 2 more directory(s)");
		// The concrete paths stay one hover away: the row title already carries
		// the primary workspace, so the count is what the line can afford.
		expect(hint?.title).toBe(ROOTS.join("\n"));
	});

	test("leaves a single-directory session without the hint", async () => {
		await mountAllSessions();

		expect(rootsHint(sessionRow("Single-root session"))).toBeNull();
		expect(sessionRow("Single-root session").textContent).not.toContain("directory(s)");
	});
});
