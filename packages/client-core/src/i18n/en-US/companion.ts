import type { CompanionKey } from "../zh-CN/companion.js";
export const companion = {
	// ── Builtin pet preset names/descriptions (English source = key) ──
	"companion.boxcat": "Boxcat",
	"companion.tinyCatTucked.info":
		"A tiny cat tucked inside a cardboard box for cozy coding sessions.",
	"companion.capy": "Capy",
	"companion.originalEmotionallyStable.info":
		"An original emotionally stable capybara with a tiny orange on its head.",
	"companion.jiyi": "Jiyi",
	"companion.roundWhiteChibi.desc":
		"A round white chibi bear with dark chocolate outlines, pink cheeks, tiny limbs, curled ears, and a small pink bear pouch.",
	"companion.hachiware": "Hachiware",
	"companion.tinyHachiwareInspired.info":
		"A tiny Hachiware-inspired desktop pet with white and blue cat markings, bright eyes, and cheerful expressions.",
	"companion.usagi": "Usagi",
	"companion.tinyCreamRabbitCompanion":
		"A tiny cream rabbit companion based on the provided Usagi reference.",
	"companion.hanLi": "Han Li",
	"companion.calmCautiousQ.info":
		"A calm, cautious Q-version of Han Li in a dark-cyan Daoist robe, quietly riding his sword.",
	"companion.doraemon": "Doraemon",
	"companion.compactBlueRobotCat": "A compact blue robot-cat pet inspired by Doraemon.",
	"companion.noirWebling": "Noir Webling",
	"companion.tinyMonochromeSpiderDetective":
		"A tiny monochrome spider detective in a fedora and trench coat.",
	"companion.feixue": "Feixue",
	"companion.whiteHairedRed.info":
		"A white-haired, red-eyed character from Wuthering Waves, made into a pixel desktop pet.",
	"companion.petRefresh": "Refresh list",
	"companion.petMarket": "Petdex market",
	"companion.petMarketSearchPlaceholder": "Search pets (name, anime, style)…",
	"companion.petMarketInstall": "Install",
	"companion.petInstalled": "Installed",
	"companion.petMarketSearching": "Searching…",
	"companion.petMarketEmpty": "No matching pets found",
	"companion.petMarketError": "Petdex search failed: {reason}",
	"companion.soundEffectsCatalog": "Sound library",
	"companion.previewEachEffect.info":
		"Preview each effect; dimmed ones are not wired to the UI yet",
	"companion.preview": "Preview",
	"companion.notWiredUiYet": "Not wired to the UI yet",
	"companion.sendMessageApprovalRequest": "Send message, approval request arrives",
	"companion.firstMessagePromptEnhanced": "First message sent, prompt enhancement complete",
	"companion.connectErrorApprovalDenied": "Connection failure, approval denied",
	"companion.sessionSwitch": "Switch session",
	"companion.stopCurrentTurn": "Stop the current turn",
	"companion.approvalGranted": "Approval granted",
	"companion.toolResultArrived": "Tool result returned",
	"companion.soundPalette": "Sound library",
} as const satisfies Record<CompanionKey, string>;
