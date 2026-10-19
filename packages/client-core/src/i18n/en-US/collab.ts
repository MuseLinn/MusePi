import type { CollabKey } from "../zh-CN/collab.js";

export const collab = {
	// ── Collab link ───────────────────────────────────────────────────────────
	"collab.invalidRelayUrlWithUrl": "Invalid relay URL: {url}",
	"collab.unsupportedRelayUrlSchemeWithScheme": "Unsupported relay URL scheme: {scheme}",
	"collab.relayLinkMustWss":
		"Relay link must be wss:// (plain ws:// is only allowed for localhost)",
	"collab.invalidCollabLinkWithUrl": "Invalid collab link: {url}",
	"collab.collabLinkMustContain": "Collab link must contain a /r/<roomId> path",
	"collab.collabLinkMissingKey": "Collab link is missing the <key> part",
	"collab.collabLinkKeyMust":
		"Collab link key must be 32 (view) or 48 (full) base64url bytes",
	"collab.browserCryptoUnavailable.info":
		"Browser crypto is unavailable on insecure http: use localhost or the tunnel wss link",
	"collab.plaintextSessionNot.info":
		"Plaintext session: not encrypted — anyone on this network can read it",
} as const satisfies Record<CollabKey, string>;
