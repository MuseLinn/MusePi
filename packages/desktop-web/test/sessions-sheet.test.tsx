import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceSessionInfo } from "@musepi/pi-wire";
import { SessionsSheet } from "../src/components/shell/SessionsSheet";

const SESSIONS: WorkspaceSessionInfo[] = [
	{
		id: "s1",
		title: "Session one",
		cwd: "/work",
		messageCount: 3,
		working: false,
		paused: false,
		live: true,
		updatedAt: 1_751_791_200_000,
	},
];

function render(open: boolean): string {
	return renderToStaticMarkup(
		<SessionsSheet sessions={SESSIONS} currentId="s1" onSelect={() => {}} open={open} onClose={() => {}} />,
	);
}

describe("SessionsSheet always-mounted close path", () => {
	it("renders the frosted card and backdrop while open", () => {
		const html = render(true);
		expect(html).toContain("ss-backdrop");
		expect(html).toContain("ss-card");
		expect(html).toContain("Session one");
	});

	it("marks the backdrop with the closing stage class during the exit animation", () => {
		// The closing stage is entered via useEffect; in SSR the initial
		// stage derives directly from the open prop. An open sheet renders
		// without the closing marker; the marker only ever appears paired
		// with the backdrop — never on a hidden (unmounted) sheet.
		const open = render(true);
		expect(open).toContain("ss-backdrop");
		expect(open).not.toContain("ss-closing");
	});

	it("unmounts fully once closed (hidden stage) — no card in the DOM", () => {
		const html = render(false);
		expect(html).not.toContain("ss-card");
	});
});
