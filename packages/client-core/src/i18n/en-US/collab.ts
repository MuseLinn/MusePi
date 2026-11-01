import type { CollabKey } from "../zh-CN/collab.js";

export const collab = {
	// ── Collab link ───────────────────────────────────────────────────────────
	"collab.invalidRelayUrlWithUrl": "Invalid relay URL: {url}",
	"collab.unsupportedRelayUrlSchemeWithScheme": "Unsupported relay URL scheme: {scheme}",
	"collab.relayLinkMustWss": "Relay link must be wss:// (plain ws:// is only allowed for localhost)",
	"collab.invalidCollabLinkWithUrl": "Invalid remote access link: {url}",
	"collab.collabLinkMustContain": "Remote access link must contain a /r/<roomId> path",
	"collab.collabLinkMissingKey": "Remote access link is missing the <key> part",
	"collab.collabLinkKeyMust": "Remote access link key must be 32 (view) or 48 (full) base64url bytes",
	"collab.browserCryptoUnavailable.info":
		"Browser crypto is unavailable on insecure http: use localhost or the tunnel wss link",
	"collab.plaintextSessionNot.info": "Plaintext session: not encrypted — anyone on this network can read it",
	"Invalid relay URL: {url}": "Invalid relay URL: {url}",
	"Unsupported relay URL scheme: {scheme}": "Unsupported relay URL scheme: {scheme}",
	"relay link must be wss:// (plain ws:// is only allowed for localhost)":
		"relay link must be wss:// (plain ws:// is only allowed for localhost)",
	"Invalid collab link: {url}": "Invalid remote access link: {url}",
	"Collab link must contain a /r/<roomId> path": "Remote access link must contain a /r/<roomId> path",
	"Collab link is missing the <key> part": "Remote access link is missing the <key> part",
	"Collab link key must be 32 (view) or 48 (full) base64url bytes":
		"Remote access link key must be 32 (view) or 48 (full) base64url bytes",
	"browser crypto unavailable on insecure http: use localhost or the tunnel wss link":
		"browser crypto unavailable on insecure http: use localhost or the tunnel wss link",
	"plaintext session: not encrypted — anyone on this network can read it":
		"plaintext session: not encrypted — anyone on this network can read it",
} as const satisfies Record<CollabKey, string>;
