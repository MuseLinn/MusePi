/**
 * Example extension: contributes a renderer-side component to the
 * "transcript.node" seat slot — the DSH `conversation.chat.node` analog.
 * The daemon compiles ui/user-note.tsx to self-contained ESM; the GUI
 * dispatches transcripts by node kind (transcriptNodeKind) and hands this
 * component the entry it OWNS (entryKinds: ["message:user"]).
 *
 * Install: copy this directory to
 * ~/.musepi/agent/extensions/extension-transcript-node/
 * (or symlink it), then open a session in the desktop GUI.
 */
import type { ExtensionAPI } from "../../src/extensibility/extensions/types";

export default function (pi: ExtensionAPI): void {
	pi.registerComponent({
		slot: "transcript.node",
		moduleUrl: "./ui/user-note.tsx",
		label: "User-note node",
		// Dispatch key(s): which transcriptNodeKind entries this renderer owns.
		// Unregistered kinds fall through to the built-in rendering (DSH fallback).
		entryKinds: ["message:user"],
	});
}
