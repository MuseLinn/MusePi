import type { CollabKey } from "../zh-CN/collab.js";

export const collab = {
	// ── Collab link ───────────────────────────────────────────────────────────
	"Invalid relay URL: {url}": "Invalid relay URL: {url}",
	"Unsupported relay URL scheme: {scheme}": "Unsupported relay URL scheme: {scheme}",
	"relay link must be wss:// (plain ws:// is only allowed for localhost)":
		"Relay link must be wss:// (plain ws:// is only allowed for localhost)",
	"Invalid collab link: {url}": "Invalid collab link: {url}",
	"Collab link must contain a /r/<roomId> path": "Collab link must contain a /r/<roomId> path",
	"Collab link is missing the <key> part": "Collab link is missing the <key> part",
	"Collab link key must be 32 (view) or 48 (full) base64url bytes":
		"Collab link key must be 32 (view) or 48 (full) base64url bytes",
	"browser crypto unavailable on insecure http: use localhost or the tunnel wss link":
		"Browser crypto is unavailable on insecure http: use localhost or the tunnel wss link",
	"plaintext session: not encrypted — anyone on this network can read it":
		"Plaintext session: not encrypted — anyone on this network can read it",
} as const satisfies Record<CollabKey, string>;
