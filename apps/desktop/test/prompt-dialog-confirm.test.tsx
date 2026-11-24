/**
 * Confirm dialog typography contract.
 *
 * A confirm names what it is about to do and explains it below. The provider
 * used to receive one string and render all of it in the heading, so a caller
 * that quoted a whole turn produced a dialog whose entire body was set as a
 * 17px/600 heading (user report: the withdraw dialog read as a wall of bold
 * text, and the quoted prompt appeared twice).
 */
import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PromptProvider, useConfirm } from "../src/lib/prompt-dialog";

type Confirm = ReturnType<typeof useConfirm>["confirm"];

const roots: Root[] = [];
let confirmRef: Confirm | null = null;

afterEach(() => {
	for (const root of roots.splice(0)) root.unmount();
	document.body.innerHTML = "";
	confirmRef = null;
});

function mountProvider(): Confirm {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);

	function Probe(): null {
		confirmRef = useConfirm().confirm;
		return null;
	}

	act(() => {
		root.render(
			<PromptProvider>
				<Probe />
			</PromptProvider>,
		);
	});
	if (!confirmRef) throw new Error("PromptProvider did not expose confirm");
	return confirmRef;
}

describe("confirm dialog", () => {
	it("splits a title/body message so the body keeps body typography", async () => {
		const confirm = mountProvider();
		let answer: Promise<boolean> | undefined;
		act(() => {
			answer = confirm("More than one paragraph\n\nThis part explains what happens next.");
		});

		expect(document.querySelector(".gui-dialog--confirm h3")?.textContent).toBe("More than one paragraph");
		const body = [...document.querySelectorAll(".gui-dialog--confirm p")].map(node => node.textContent);
		expect(body).toEqual(["This part explains what happens next."]);

		await act(async () => {
			(document.querySelector(".gui-dialog--confirm .gui-btn-primary") as HTMLButtonElement | null)?.click();
		});
		expect(await answer).toBe(true);
	});

	it("keeps an explicit body's paragraph breaks and never repeats the heading", async () => {
		const confirm = mountProvider();
		act(() => {
			void confirm("“withdraw this turn”", "Withdraw", { body: "First note.\n\nSecond note." });
		});

		expect(document.querySelector(".gui-dialog--confirm h3")?.textContent).toBe("“withdraw this turn”");
		const body = [...document.querySelectorAll(".gui-dialog--confirm p")].map(node => node.textContent);
		expect(body).toEqual(["First note.", "Second note."]);
		expect(body.join(" ")).not.toContain("withdraw this turn");
	});
});
