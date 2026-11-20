import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ComposerAttachment } from "../src/components/composer/use-attachments";
import { useDraftPersistence } from "../src/components/composer/use-draft-persistence";

/** Minimal host: the hook only needs text/attachments state and a session id. */
function Harness({
	sessionId,
	carryText,
	seen,
}: {
	sessionId: string;
	carryText?: string;
	seen: { text: string };
}): ReactNode {
	const [text, setText] = useState("");
	const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
	useDraftPersistence({ sessionId, rpc: null, text, setText, attachments, setAttachments, carryText });
	seen.text = text;
	return null;
}

async function mount(
	sessionId: string,
	carryText?: string,
): Promise<{ seen: { text: string }; render: (id: string, carry?: string) => Promise<void> }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const seen = { text: "" };
	await act(async () => {
		root.render(<Harness sessionId={sessionId} carryText={carryText} seen={seen} />);
	});
	return {
		seen,
		render: async (id, carry) => {
			await act(async () => {
				root.render(<Harness sessionId={id} carryText={carry} seen={seen} />);
			});
		},
	};
}

afterEach(() => {
	localStorage.clear();
	document.body.innerHTML = "";
});

/**
 * The carried draft is the welcome skin's un-sent text, handed to a session the
 * user opens. It must only fill a box that has no stored draft of its own, and
 * it must be consumed once — otherwise a later session switch re-seeds it.
 */
describe("useDraftPersistence carry", () => {
	it("adopts the carried draft when the session has none", async () => {
		const { seen } = await mount("s1", "DRAFT-PROBE");
		expect(seen.text).toBe("DRAFT-PROBE");
	});

	it("prefers the session's own stored draft", async () => {
		localStorage.setItem("musepi-gui-draft:s1", "OWN-DRAFT");
		const { seen } = await mount("s1", "DRAFT-PROBE");
		expect(seen.text).toBe("OWN-DRAFT");
	});

	it("consumes the carry once, so a later session does not re-seed it", async () => {
		const { seen, render } = await mount("s1", "DRAFT-PROBE");
		expect(seen.text).toBe("DRAFT-PROBE");
		await render("s2", "");
		expect(seen.text).toBe("");
	});
});
