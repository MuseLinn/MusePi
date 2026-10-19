/**
 * Creation surface domain — English mirror of zh-CN/creation.ts (M3.7a design
 * mode page; the six-tab form and its field-level copy were retired with it).
 * Must satisfy Record<CreationKey, string>: a missing or extra key is a
 * compile error.
 */
import type { CreationKey } from "../zh-CN/creation.js";

export const creation = {
	"creation.creationTitle": "Create",
	"creation.creationClose": "Close creation panel",
	// Start-from picker: choose a shape; nothing is created until submit.
	"creation.creationStart": "Start from",
	"creation.creationStartBlank": "Blank start",
	"creation.creationStartBlankHint": "No shape — just start",
	"creation.creationTabPrototype": "Prototype",
	"creation.creationTabLiveArtifact": "Live Artifact",
	"creation.creationTabDeck": "Deck",
	"creation.creationTabTemplate": "Template",
	"creation.creationTabMedia": "Media",
	"creation.creationTabOther": "Other",
	"creation.creationMediaImage": "Image",
	"creation.creationMediaVideo": "Video",
	"creation.creationMediaAudio": "Audio",
	"creation.creationPlaceholderPrototype": "Describe the interface, style and mood you want…",
	"creation.creationPlaceholderLiveArtifact": "Describe what this living artifact should keep showing…",
	"creation.creationPlaceholderDeck": "Describe the deck's topic, length and audience…",
	"creation.creationPlaceholderImage": "Describe the subject, style and lighting…",
	"creation.creationPlaceholderVideo": "Describe the shots, rhythm and style…",
	"creation.creationPlaceholderAudio": "Describe the mood, rhythm and purpose of the sound…",
	"creation.creationPlaceholderTemplate": "Pick a template to start, or switch type and just describe it…",
	"creation.creationPlaceholderOther": "Describe what you want to make…",
	"creation.creationTemplatesTitle": "Session templates",
	"creation.creationTemplatesEmpty":
		"No templates yet. Create a prototype or deck, then save it as a template from the success toast.",
	// Blank-start equivalent in the empty state (opendesign StartFromPicker's Blank-first):
	// focus the composer — typing and sending creates a session, so the empty state never dead-ends.
	"creation.creationTemplatesBlankStart": "Start blank: type a request above and send",
	"creation.creationTemplateDelete": "Delete",
	"creation.creationTemplateConfirmDelete": 'Delete template "{name}"? This cannot be undone.',
	"creation.creationTemplateUnnamed": "Unnamed template",
	"creation.creationSavedToast": "Session created",
	"creation.creationTemplateSaveAction": "Save as template",
	"creation.creationTemplateSaved": "Saved as template",
	// Asset policy + "Advanced ▸" fold (M3.7c §4; the fold's type-specific
	// field copy reuses the M3.1 per-field table / M3.2 form wording).
	"creation.creationAssetPolicyLabel": "Assets",
	"creation.creationAssetPolicyAi": "AI image",
	"creation.creationAssetPolicyPlaceholder": "Color placeholder",
	"creation.creationAdvanced": "Advanced",
	"creation.creationPlatformLabel": "Platforms",
	"creation.creationPlatformResponsive": "Responsive",
	"creation.creationPlatformWebDesktop": "Desktop Web",
	"creation.creationPlatformMobileIos": "iOS",
	"creation.creationPlatformMobileAndroid": "Android",
	"creation.creationPlatformTablet": "Tablet",
	"creation.creationPlatformDesktopApp": "Desktop app",
	"creation.creationFidelityLabel": "Fidelity",
	"creation.creationFidelityWireframe": "Wireframe",
	"creation.creationFidelityHighFidelity": "High-fidelity",
	"creation.creationSurfaceLanding": "Include landing page",
	"creation.creationSurfaceOsWidgets": "Include OS widgets",
	"creation.creationSpeakerNotes": "Speaker notes",
	"creation.creationMediaModelLabel": "Model",
	"creation.creationMediaAspectLabel": "Aspect",
	"creation.creationMediaDurationLabel": "Duration",
	"creation.creationMediaDurationSec": "{sec}s",
	"creation.creationMediaAudioKind": "Kind",
	"creation.creationMediaKindSpeech": "Speech",
	"creation.creationMediaKindSfx": "SFX",
	"creation.creationMediaVoiceLabel": "Voice",
	"creation.creationMediaVoicePlaceholder": "Voice name, e.g. warm-female",
	"creation.creationMediaNoProviders": "No providers available — configure one in Settings → Media Generation.",
	"creation.creationMediaNotConfigured": "Not configured",
	"creation.creationMediaConfigured": "Configured",
} as const satisfies Record<CreationKey, string>;
