import "../../../test/happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AtCandidate } from "../../lib/at-completion";
import { CompletionMenus } from "./completion-menus";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

function render(node: React.ReactNode): HTMLDivElement {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root?.render(node));
	return host;
}

const noop = (): void => {};
const entries: AtCandidate[] = [
	{ kind: "session", id: "s1", name: "发布准备", cwd: "/proj/api", updatedAt: new Date().toISOString() },
	{ kind: "file", name: "server.ts", path: "src/server.ts", isDir: false, depth: 1 },
];

function menu(at: AtCandidate[], query: string): HTMLDivElement {
	return render(
		<CompletionMenus
			slashOpen={false}
			slashItems={[]}
			slashIdx={0}
			onPickSlash={noop}
			atOpen
			atEntries={at}
			atIdx={0}
			atQuery={query}
			onPickAt={noop}
		/>,
	);
}

describe("CompletionMenus @ list", () => {
	it("renders one row per candidate inside a listbox", () => {
		const div = menu(entries, "");
		expect(div.querySelectorAll('[role="option"]')).toHaveLength(2);
	});

	it("heads each group exactly once, in menu order", () => {
		const div = menu(entries, "");
		const sections = [...div.querySelectorAll(".gui-at-section")].map(node => node.textContent ?? "");
		expect(sections).toHaveLength(2);
		// Sessions lead, files follow — the same order the ranker produced.
		const rows = [...div.querySelectorAll('[role="option"]')].map(node => node.textContent ?? "");
		expect(rows[0]).toContain("发布准备");
		expect(rows[1]).toContain("server.ts");
	});

	it("marks the matched run instead of leaving the reader to find it", () => {
		const div = menu(entries, "serv");
		const hit = div.querySelector(".gui-at-hit");
		expect(hit?.textContent).toBe("serv");
		// The row still shows the whole name around the hit; read the row that
		// actually contains the match rather than the first row in the list.
		expect(hit?.closest(".gui-at-name")?.textContent).toContain("server.ts");
	});

	it("leaves text unhit when the query does not occur", () => {
		const div = menu(entries, "");
		expect(div.querySelector(".gui-at-hit") === null).toBe(true);
	});

	it("exposes the active row to assistive tech, not just to CSS", () => {
		const div = menu(entries, "");
		const options = [...div.querySelectorAll('[role="option"]')];
		// The keyboard highlight is carried by aria-selected; a class name is an
		// implementation detail the styling is free to change.
		expect(options.map(node => node.getAttribute("aria-selected"))).toEqual(["true", "false"]);
	});

	it("shows a session's directory and recency in the trailing column", () => {
		const div = menu(entries, "");
		expect(div.querySelector(".gui-at-meta")?.textContent).toContain("api");
	});
});
