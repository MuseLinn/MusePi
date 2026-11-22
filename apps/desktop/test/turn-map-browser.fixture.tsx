import { createRoot } from "react-dom/client";
import { TurnMapCanvas } from "../src/components/TurnMapCanvas";

/**
 * Real-mount fixture for the map: Chromium gets the actual component with its
 * React event handlers, so keyboard traversal and hit-testing are exercised
 * the way a browser does it. SSR markup cannot answer those questions —
 * dispatching `keydown` onto server-rendered HTML reaches no handler at all.
 */

function msg(id: string, parentId: string | null, role: string, text: string, ts: number) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: { role, content: [{ type: "text", text }] },
	};
}

/** Three live turns: enough for two main edges and three cards. */
function linearEntries(turns: number): unknown[] {
	const out: unknown[] = [];
	let parent: string | null = null;
	for (let i = 1; i <= turns; i++) {
		out.push(msg(`u${i}`, parent, "user", `question ${i}`, i * 2000));
		parent = `u${i}`;
		out.push(msg(`a${i}`, parent, "assistant", `answer ${i}`, i * 2000 + 1000));
		parent = `a${i}`;
	}
	return out;
}

/** t1→t2→t3 live; t4 withdrawn off t1; t5 withdrawn off t4; t6 withdrawn off t3. */
function nestedBranchEntries(): unknown[] {
	return [
		msg("u1", null, "user", "first question", 1000),
		msg("a1", "u1", "assistant", "first answer", 2000),
		msg("u2", "a1", "user", "second question", 3000),
		msg("a2", "u2", "assistant", "second answer", 4000),
		msg("u3", "a2", "user", "third question", 5000),
		msg("a3", "u3", "assistant", "third answer", 6000),
		// withdrawn re-ask off turn 1
		msg("u4", "a1", "user", "withdrawn one", 7000),
		msg("a4", "u4", "assistant", "withdrawn one answer", 8000),
		// nested withdrawn re-ask off turn 4
		msg("u5", "a4", "user", "withdrawn two", 9000),
		msg("a5", "u5", "assistant", "withdrawn two answer", 10000),
		// withdrawn re-ask off turn 3
		msg("u6", "a3", "user", "withdrawn three", 11000),
		msg("a6", "u6", "assistant", "withdrawn three answer", 12000),
	];
}

const root = document.getElementById("root");
if (!root) throw new Error("Turn map fixture root is missing");
// The shape rides on the document element, so it is guaranteed to be in the
// same document the bundle is evaluated in. (`location.search` is unusable:
// `page.setContent` runs at about:blank, where replaceState throws.)
const dataset = document.documentElement.dataset;
const shape = dataset.turnMapShape ?? "linear";
const entries = shape === "nested" ? nestedBranchEntries() : linearEntries(Number(dataset.turnMapTurns ?? 3));
// The withdrawn turns are the off-path set; the live ones stay main line.
const liveIds =
	shape === "nested"
		? new Set(["u1", "a1", "u2", "a2", "u3", "a3"])
		: new Set(entries.map(e => (e as { id: string }).id));

// Jumps are observable so the harness can prove a real Enter reaches
// `onJumpToEntry` — the map's own jump is a callback, not a DOM mutation.
// The record rides in the DOM, not on `globalThis`: puppeteer's `evaluate`
// runs in an isolated world, so a global set by an injected script is invisible
// to the harness, while DOM attributes are shared.
const jumpLog = document.createElement("div");
jumpLog.id = "turn-map-jumps";
jumpLog.dataset.jumps = "";
document.body.appendChild(jumpLog);
const recordJump = (entryId: string): void => {
	const previous = jumpLog.dataset.jumps ?? "";
	jumpLog.dataset.jumps = previous ? `${previous},${entryId}` : entryId;
};
createRoot(root).render(<TurnMapCanvas entries={entries} pathIds={liveIds} leafId="a3" onJumpToEntry={recordJump} />);
