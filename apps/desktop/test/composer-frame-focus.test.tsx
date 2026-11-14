import "./happy-dom-shim";
import { afterEach, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComposerFrame } from "../src/lib/composer-frame";

const roots = new Set<Root>();
afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
	document.head.innerHTML = "";
});

it("keeps the focused pet inside the frame and lays out placeholder and glow correctly", async () => {
	const sheet = document.createElement("style");
	sheet.textContent = [
		readFileSync(resolve(import.meta.dir, "../src/styles/gui-composer.css"), "utf8"),
		readFileSync(resolve(import.meta.dir, "../src/styles/gui-pet.css"), "utf8"),
		readFileSync(resolve(import.meta.dir, "../src/styles/gui-board.css"), "utf8"),
	].join("\n");
	document.head.appendChild(sheet);
	const host = document.createElement("div");
	host.className = "gui-composer--focused";
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.add(root);
	await act(async () =>
		root.render(
			<ComposerFrame
				attachments={[]}
				onRemoveAttachment={() => {}}
				onEditSketch={() => {}}
				footerLeft={null}
				footerRight={null}
				pet={<span className="gui-pet" />}
			>
				<div className="gui-ta-stack">
					<textarea className="gui-ta-welcome" />
				</div>
			</ComposerFrame>,
		),
	);

	const pet = host.querySelector<HTMLElement>(".gui-composer-pet");
	const stack = host.querySelector<HTMLElement>(".gui-ta-stack");
	const textarea = host.querySelector<HTMLElement>("textarea");
	expect(pet).not.toBeNull();
	expect(getComputedStyle(pet!).top).toBe("6px");
	expect(getComputedStyle(pet!).bottom).toBe("auto");
	expect(pet!.getBoundingClientRect().height).toBeLessThanOrEqual(64);
	expect(getComputedStyle(stack!).marginTop).toBe("64px");
	expect(getComputedStyle(stack!).alignSelf).toBe("stretch");
	expect(getComputedStyle(textarea!).boxSizing).toBe("border-box");
	expect(getComputedStyle(host.querySelector<HTMLElement>(".gui-composer-frame")!).overflow).toBe("visible");
	expect(host.querySelector(".gui-spotlight-glow")).not.toBeNull();
});
