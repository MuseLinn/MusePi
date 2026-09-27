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
	"creation template delete": "Delete",
	"creation template confirm delete": 'Delete template "{name}"? This cannot be undone.',
	"creation template unnamed": "Unnamed template",
	"creation saved toast": "Session created",
	"creation template save action": "Save as template",
	"creation template saved": "Saved as template",
} as const satisfies Record<CreationKey, string>;
