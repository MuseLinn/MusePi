import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ImportSessionsSetup } from "../src/components/ImportSessionsSetup";
import type { RpcClient } from "../src/lib/rpc";

// Source marks: Kimi Code and Codex are real product brands, so the picker
// shows their logos instead of a generic lucide glyph. Sources without a
// brand keep the lucide + morphicons path, and an unknown source still falls
// back to the generic bot rather than rendering nothing.

const AGENTS = [
	{ source: "kimicode", name: "Kimi Code" },
	{ source: "codex", name: "Codex" },
	{ source: "dsh", name: "DeepSeek Harness" },
	{ source: "workbuddy", name: "WorkBuddy" },
	{ source: "claude", name: "Claude" },
	{ source: "mystery", name: "Mystery" },
];

const SOURCES = [
	{ source: "kimicode", name: "Kimi Code", count: 1, sessions: [row("k1", "Kimi session")] },
	{ source: "codex", name: "Codex", count: 1, sessions: [row("c1", "Codex session")] },
	{ source: "dsh", name: "DeepSeek Harness", count: 1, sessions: [row("d1", "DSH session")] },
	{ source: "workbuddy", name: "WorkBuddy", count: 1, sessions: [row("w1", "WorkBuddy session")] },
	{ source: "claude", name: "Claude", count: 1, sessions: [row("a1", "Claude session")] },
	{ source: "mystery", name: "Mystery", count: 1, sessions: [row("m1", "Mystery session")] },
];

function row(id: string, title: string) {
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
	};
}

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

async function mount(): Promise<void> {
	act(() => {
		root.render(<ImportSessionsSetup rpc={new FakeRpc() as unknown as RpcClient} />);
	});
	await flush();
}

/** The glyph slot of one source row in the picker. */
function pickerGlyph(source: string): Element {
	const name = AGENTS.find(agent => agent.source === source)?.name ?? "";
	const button = [...host.querySelectorAll(".gui-import-source")].find(
		item => item.querySelector(".gui-import-source-name")?.textContent === name,
	);
	if (!button) throw new Error(`Missing source row: ${source}`);
	const glyph = button.querySelector(".gui-import-source-glyph");
	if (!glyph) throw new Error(`Missing glyph slot: ${source}`);
	return glyph;
}

function svgTitle(svg: Element | null): string | null {
	return svg?.querySelector("title")?.textContent ?? null;
}

async function scan(): Promise<void> {
	for (const agent of AGENTS) {
		const name = agent.name;
		const button = [...host.querySelectorAll<HTMLElement>(".gui-import-source")].find(
			item => item.querySelector(".gui-import-source-name")?.textContent === name,
		);
		act(() => button?.click());
	}
	const scanButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item =>
		item.textContent?.includes("Scan"),
	);
	act(() => scanButton?.click());
	await flush();
}

describe("import source marks", () => {
	test("draws a brand logo for each source that has one", async () => {
		await mount();

		expect(svgTitle(pickerGlyph("kimicode").querySelector("svg"))).toBe("Kimi");
		expect(svgTitle(pickerGlyph("codex").querySelector("svg"))).toBe("Codex");
		expect(svgTitle(pickerGlyph("dsh").querySelector("svg"))).toBe("DeepSeek");
	});

	test("draws the Claude brand and falls back to the stroke glyph for an unknown source", async () => {
		await mount();

		expect(svgTitle(pickerGlyph("claude").querySelector("svg"))).toBe("Claude");

		const unknown = pickerGlyph("mystery").querySelector("svg");
		expect(unknown?.getAttribute("fill")).toBe("none");
		expect(unknown?.getAttribute("stroke")).toBe("currentColor");
		expect(unknown?.querySelector("path")?.getAttribute("d")).not.toBeNull();
	});

	test("uses the same brand marks in the scanned result group headers", async () => {
		await mount();
		await scan();

		const heads = [...host.querySelectorAll(".gui-import-group-head")];
		const titleFor = (name: string): string | null => {
			const head = heads.find(item => item.querySelector(".gui-import-group-name")?.textContent === name);
			return svgTitle(head?.querySelector("svg") ?? null);
		};

		expect(titleFor("Kimi Code")).toBe("Kimi");
		expect(titleFor("Codex")).toBe("Codex");
		expect(titleFor("DeepSeek Harness")).toBe("DeepSeek");
		const claudeHead = heads.find(item => item.querySelector(".gui-import-group-name")?.textContent === "Claude");
		expect(svgTitle(claudeHead?.querySelector("svg") ?? null)).toBe("Claude");
	});
});
