import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionList, type SessionListNode } from "../src/components/SessionList";

const mounted = new Set<Root>();

function node(id: string, ageMs: number): SessionListNode {
	const timestamp = new Date(Date.now() - ageMs).toISOString();
	return { entry: { type: "session", id, parentId: null, timestamp, updatedAt: timestamp, label: id }, children: [] };
}

async function mount(element: React.ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(element));
	return container;
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

describe("session row time", () => {
	it("shows the compact last-activity age, newest row first", async () => {
		const nodes = [
			node("minutes", 5 * 60_000 + 30_000),
			node("hours", 12 * 3_600_000 + 60_000),
			node("weeks", 21 * 86_400_000 + 3_600_000),
		];
		const container = await mount(<SessionList nodes={nodes} selectedId={null} onSelect={() => {}} />);
		const labels = [...container.querySelectorAll(".gui-session-time")].map(el => el.textContent);
		expect(labels).toEqual(["5m", "12h", "3w"]);
		// The old clock/date reading is gone: no "HH:MM" and no month-day date.
		expect(labels.some(label => /\d{2}:\d{2}/.test(label ?? ""))).toBe(false);
	});

	it("keeps the full timestamps in the row tooltip", async () => {
		const created = new Date(Date.now() - 3 * 86_400_000).toISOString();
		const lastActive = new Date(Date.now() - (2 * 3_600_000 + 60_000)).toISOString();
		const entry: SessionListNode = {
			entry: {
				type: "session",
				id: "tooltip",
				parentId: null,
				timestamp: created,
				updatedAt: lastActive,
				label: "tooltip",
			},
			children: [],
		};
		const container = await mount(<SessionList nodes={[entry]} selectedId={null} onSelect={() => {}} />);
		const label = container.querySelector<HTMLElement>(".gui-session-time");
		expect(label?.textContent).toBe("2h");
		expect(label?.title).toContain(t("general.lastActive"));
		expect(label?.title).toContain(t("general.createdAt"));
	});
});
