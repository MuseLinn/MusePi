/**
 * Creation surface domain — English mirror of zh-CN/creation.ts (M3.7a design
 * mode page; the six-tab form and its field-level copy were retired with it).
 * Must satisfy Record<CreationKey, string>: a missing or extra key is a
 * compile error.
 */
import type { CreationKey } from "../zh-CN/creation.js";

export const creation = {
	"creation title": "Create",
	"creation close": "Close creation panel",
	"creation tab prototype": "Prototype",
	"creation tab live artifact": "Live Artifact",
	"creation tab deck": "Deck",
	"creation tab template": "Template",
	"creation tab media": "Media",
	"creation tab other": "Other",
	"creation media image": "Image",
	"creation media video": "Video",
	"creation media audio": "Audio",
	"creation placeholder prototype": "Describe the interface, style and mood you want…",
	"creation placeholder live artifact": "Describe what this living artifact should keep showing…",
	"creation placeholder deck": "Describe the deck's topic, length and audience…",
	"creation placeholder image": "Describe the subject, style and lighting…",
	"creation placeholder video": "Describe the shots, rhythm and style…",
	"creation placeholder audio": "Describe the mood, rhythm and purpose of the sound…",
	"creation placeholder template": "Pick a template to start, or switch type and just describe it…",
	"creation placeholder other": "Describe what you want to make…",
	"creation templates title": "Session templates",
	"creation templates empty":
		"No templates yet. Create a prototype or deck, then save it as a template from the success toast.",
	// Blank-start equivalent in the empty state (opendesign StartFromPicker's Blank-first):
	// focus the composer — typing and sending creates a session, so the empty state never dead-ends.
	"creation templates blank start": "Start blank: type a request above and send",
	"creation template delete": "Delete",
	"creation template confirm delete": 'Delete template "{name}"? This cannot be undone.',
	"creation template unnamed": "Unnamed template",
	"creation saved toast": "Session created",
	"creation template save action": "Save as template",
	"creation template saved": "Saved as template",
	// Asset policy + "Advanced ▸" fold (M3.7c §4; the fold's type-specific
	// field copy reuses the M3.1 per-field table / M3.2 form wording).
	"creation asset policy label": "Assets",
	"creation asset policy ai image": "AI image",
	"creation asset policy placeholder": "Color placeholder",
	"creation advanced": "Advanced",
	"creation platform label": "Platforms",
	"creation platform responsive": "Responsive",
	"creation platform web-desktop": "Desktop Web",
	"creation platform mobile-ios": "iOS",
	"creation platform mobile-android": "Android",
	"creation platform tablet": "Tablet",
	"creation platform desktop-app": "Desktop app",
	"creation fidelity label": "Fidelity",
	"creation fidelity wireframe": "Wireframe",
	"creation fidelity high-fidelity": "High-fidelity",
	"creation surface landing": "Include landing page",
	"creation surface os widgets": "Include OS widgets",
	"creation speaker notes": "Speaker notes",
	"creation media model label": "Model",
	"creation media aspect label": "Aspect",
	"creation media duration label": "Duration",
	"creation media duration sec": "{sec}s",
	"creation media audio kind label": "Kind",
	"creation media kind speech": "Speech",
	"creation media kind sfx": "SFX",
	"creation media voice label": "Voice",
	"creation media voice placeholder": "Voice name, e.g. warm-female",
	"creation media no providers": "No providers available — configure one in Settings → Media Generation.",
	"creation media not configured": "Not configured",
	"creation media configured": "Configured",
} as const satisfies Record<CreationKey, string>;
