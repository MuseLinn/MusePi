import type { CompanionKey } from "../zh-CN/companion.js";
export const companion = {
	// ── Builtin pet preset names/descriptions (English source = key) ──
	Boxcat: "Boxcat",
	"A tiny cat tucked inside a cardboard box for cozy coding sessions.":
		"A tiny cat tucked inside a cardboard box for cozy coding sessions.",
	Capy: "Capy",
	"An original emotionally stable capybara with a tiny orange on its head.":
		"An original emotionally stable capybara with a tiny orange on its head.",
	Jiyi: "Jiyi",
	"A round white chibi bear with dark chocolate outlines, pink cheeks, tiny limbs, curled ears, and a small pink bear pouch.":
		"A round white chibi bear with dark chocolate outlines, pink cheeks, tiny limbs, curled ears, and a small pink bear pouch.",
	Hachiware: "Hachiware",
	"A tiny Hachiware-inspired desktop pet with white and blue cat markings, bright eyes, and cheerful expressions.":
		"A tiny Hachiware-inspired desktop pet with white and blue cat markings, bright eyes, and cheerful expressions.",
	Usagi: "Usagi",
	"A tiny cream rabbit companion based on the provided Usagi reference.":
		"A tiny cream rabbit companion based on the provided Usagi reference.",
	"Han Li": "Han Li",
	"A calm, cautious Q-version of Han Li in a dark-cyan Daoist robe, quietly riding his sword.":
		"A calm, cautious Q-version of Han Li in a dark-cyan Daoist robe, quietly riding his sword.",
	Doraemon: "Doraemon",
	"A compact blue robot-cat pet inspired by Doraemon.": "A compact blue robot-cat pet inspired by Doraemon.",
	"Noir Webling": "Noir Webling",
	"A tiny monochrome spider detective in a fedora and trench coat.":
		"A tiny monochrome spider detective in a fedora and trench coat.",
	Feixue: "Feixue",
	"A white-haired, red-eyed character from Wuthering Waves, made into a pixel desktop pet.":
		"A white-haired, red-eyed character from Wuthering Waves, made into a pixel desktop pet.",
	"pet refresh": "Refresh list",
	"pet market": "Petdex market",
	"pet market search placeholder": "Search pets (name, anime, style)…",
	"pet market install": "Install",
	"pet installed": "Installed",
	"pet market searching": "Searching…",
	"pet market empty": "No matching pets found",
	"pet market error": "Petdex search failed: {reason}",
	"sound effects catalog": "Sound library",
	"preview each effect; dimmed ones are not wired to the UI yet":
		"Preview each effect; dimmed ones are not wired to the UI yet",
	preview: "Preview",
	"not wired to the UI yet": "Not wired to the UI yet",
	"send message, approval request": "Send message, approval request arrives",
	"first message, prompt enhanced": "First message sent, prompt enhancement complete",
	"connect error, approval denied": "Connection failure, approval denied",
	"session switch": "Switch session",
	"stop current turn": "Stop the current turn",
	"approval granted": "Approval granted",
	"tool result arrived": "Tool result returned",
	"sound palette": "Sound library",
} as const satisfies Record<CompanionKey, string>;

