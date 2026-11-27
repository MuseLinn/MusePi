import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryModeChip, type SessionMemoryMode } from "../src/components/MemoryModePicker";

let host: HTMLDivElement;
let root: Root;
let value: SessionMemoryMode;

beforeEach(() => {
	host = document.createElement("div");
	host.id = "root";
	document.body.appendChild(host);
	root = createRoot(host);
	value = "persistent";
});

afterEach(async () => {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 160));
		root.unmount();
	});
	host.remove();
});

describe("MemoryModeChip", () => {
	test("offers all three modes and reports the selected privacy behavior", async () => {
		await act(async () => root.render(<MemoryModeChip value={value} onChange={mode => (value = mode)} />));
		await act(async () => {
			host.querySelector<HTMLButtonElement>(".gui-memory-chip")?.click();
			await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		});
		expect(document.querySelectorAll(".gui-memory-mode-option").length).toBe(3);
		await act(async () => document.querySelector<HTMLButtonElement>('[data-memory-mode="incognito"]')?.click());
		expect(value).toBe("incognito");
		await act(async () => root.render(<MemoryModeChip value={value} onChange={mode => (value = mode)} />));
		expect(host.querySelector(".gui-memory-chip")?.textContent).toContain("Incognito");
	});
});
