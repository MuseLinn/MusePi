/**
 * Final pass of the i18n key migration: the remaining files hold keys in
 * template-literal prefixes, `as const` tuples and Record maps. Every quoted
 * literal in these files that has a mapping IS a translation key — verified by
 * reading each file — so a full-literal swap is correct here (this is the same
 * rule the earlier sweeps applied too broadly; the difference is the file list,
 * which is now exhaustive and hand-checked).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const apply = process.argv.includes("--apply");

const raw = JSON.parse(fs.readFileSync(path.resolve(root, "scripts/i18n-key-migration.json"), "utf8"));
const cc: Record<string, string> = raw["client-core"] ?? {};

const FILES = [
	"packages/desktop-app/src/components/ArtifactsPanel.tsx",
	"packages/desktop-app/src/components/ComputerPermissionsDialog.tsx",
	"packages/desktop-app/src/components/ContextPanel.tsx",
	"packages/desktop-app/src/components/ManagedBrowserPane.tsx",
	"packages/desktop-app/src/components/NavRail.tsx",
	"packages/desktop-app/src/components/OnboardingOverlay.tsx",
	"packages/desktop-app/src/components/SessionList.tsx",
	"packages/desktop-app/src/components/SketchPad.tsx",
	"packages/desktop-app/src/components/SkillMarketView.tsx",
	"packages/desktop-app/src/components/TurnMapCanvas.tsx",
	"packages/desktop-app/src/components/WelcomeComposer.tsx",
	"packages/desktop-app/src/components/composer/approval-mode-button.tsx",
	"packages/desktop-app/src/components/composer/connector-panel.tsx",
	"packages/desktop-app/src/components/settings-sections/computer-permissions.tsx",
	"packages/desktop-app/src/components/settings-sections/voice.tsx",
	"packages/desktop-app/test/design-systems-gui.test.tsx",
	"packages/desktop-app/test/session-sidebar-search.test.tsx",
	"packages/desktop-app/test/turn-map-canvas.test.tsx",
].map(f => path.resolve(root, f));

let touched = 0;
let swapped = 0;

for (const file of FILES) {
	if (!fs.existsSync(file)) continue;
	let source = fs.readFileSync(file, "utf8");
	const before = source;
	for (const [oldKey, newKey] of Object.entries(cc)) {
		if (!newKey || oldKey.includes("\u0000")) continue;
		const lit = JSON.stringify(oldKey);
		if (!source.includes(lit)) continue;
		swapped += source.split(lit).length - 1;
		source = source.split(lit).join(JSON.stringify(newKey));
	}
	if (source !== before) {
		if (apply) fs.writeFileSync(file, source);
		touched += 1;
	}
}

console.log(`files ${apply ? "written" : "to write"}: ${touched}, literals swapped: ${swapped}`);
if (!apply) console.log("(dry run — pass --apply to write)");
