/**
 * Connection-locations surfaces, as the shell renders them.
 *
 * These scenarios exist because three defects reached review in one change: a
 * transport card stretched to 272px by an inherited `flex: 1`, a Docker card
 * showing WSL copy, and a form that offered two competing pickers. None is
 * visible by reading the JSX, and all three are obvious from a box and a
 * computed property.
 *
 * The expectations are the contract: a card is ~94px tall because it wraps two
 * lines of copy, the ssh card puts the form in a remote state, and the location
 * chips appear only for a container.
 */
import { t } from "@musepi/client-core";
import { ConnectionManager } from "../../src/components/ConnectionManager";
import { localTarget } from "../../src/lib/connection/targets";
import {
	clickText,
	countAll,
	type GuiScenario,
	measure,
	mount,
	readBox,
	readElement,
} from "../gui-probe-helpers";

const manager = () => (
	<ConnectionManager
		state={"disconnected-by-user" as never}
		targets={[localTarget()]}
		statuses={{}}
		onAdd={() => {}}
		onRemove={() => {}}
		onConnect={() => {}}
		onCopy={() => {}}
	/>
);

const SELECTORS = {
	form: ".gui-conn-form",
	firstCard: ".gui-conn-transport-card",
	cardGrid: ".gui-conn-cards",
	locationGroup: '.gui-conn-form [role="radiogroup"][aria-label="运行位置"]',
	addButton: ".gui-conn-add",
};

const scenarios = {
	"transport-cards": {
		capture: ".gui-conn-form",
		async render(root: HTMLElement) {
			await mount(manager(), root);
			await clickText(root, "button", t("settings.addInstance"));
		},
		async measure(body: ParentNode) {
			return {
				elements: measure(body, SELECTORS),
				cardCount: countAll(body, ".gui-conn-transport-card"),
				cards: Array.from(body.querySelectorAll<HTMLElement>(".gui-conn-transport-card")).map(card => ({
					label: card.querySelector(".gui-conn-transport-label")?.textContent ?? "",
					hint: card.querySelector(".gui-conn-transport-hint")?.textContent ?? "",
					box: readBox(card),
				})),
				formHeight: readBox(body.querySelector(".gui-conn-form"))?.h ?? null,
			};
		},
		// Only the always-present parts are asserted here; whether the location
		// chips appear at all is what the next two scenarios decide, and asserting
		// their absence by selector would pass for the wrong reason.
		expect: {
			firstCard: { display: "flex", cursor: "pointer", "box.h": { max: 120 } },
			form: { display: "flex", "box.h": { max: 460 } },
		},
	},

	"container-asks-location": {
		capture: ".gui-conn-form",
		async render(root: HTMLElement) {
			await mount(manager(), root);
			await clickText(root, "button", t("settings.addInstance"));
			await clickText(root, ".gui-conn-transport-card", t("settings.connectionKindDocker"));
		},
		async measure(body: ParentNode) {
			const chips = Array.from(
				body.querySelectorAll<HTMLElement>('.gui-conn-form [role="radiogroup"] button[role="radio"]'),
			);
			return {
				elements: measure(body, SELECTORS),
				// Only a container asks where it runs; a WSL distribution is local
				// by definition and an ssh host IS the remote location.
				locationChips: chips
					.filter(chip => (chip.textContent ?? "").includes(t("settings.locationThisComputer")))
					.map(chip => readElement(chip)),
				formHeight: readBox(body.querySelector(".gui-conn-form"))?.h ?? null,
			};
		},
	},

	"ssh-asks-no-location": {
		capture: ".gui-conn-form",
		async render(root: HTMLElement) {
			await mount(manager(), root);
			await clickText(root, "button", t("settings.addInstance"));
			await clickText(root, ".gui-conn-transport-card", t("settings.connectionKindSsh"));
		},
		async measure(body: ParentNode) {
			const inputs = Array.from(body.querySelectorAll<HTMLInputElement>(".gui-conn-form input.gui-input"));
			return {
				elements: measure(body, SELECTORS),
				// The host field is what proves the ssh card reached a remote state.
				hasHostField: inputs.some(input => input.placeholder === t("settings.connectionSshHostPlaceholder")),
				locationChips: countAll(
					body,
					`.gui-conn-form [role="radiogroup"][aria-label="${t("settings.instanceLocation")}"]`,
				),
			};
		},
	},
};

export default scenarios satisfies Record<string, GuiScenario>;
