/**
 * The secret card at every state a reader meets, so a layout change can be
 * judged against the whole set rather than the one state in hand.
 *
 * What this probe can answer: geometry, hierarchy order, which lines exist.
 * What it cannot: `:hover` and `:focus-visible`, because a synthetic screenshot
 * pass never establishes a real pointer. Hold-to-reveal is checked by the
 * component's own test instead.
 */
import { SecretCard } from "../../src/components/SecretCard";
import { type GuiScenario, clickText, countAll, measure, mount, readElement } from "../gui-probe-helpers";

const SELECTORS = {
	card: ".gui-secret-card",
	identity: ".gui-secret-identity",
	chip: ".gui-secret-name-chip",
	scope: ".gui-secret-scope",
	scopeLabel: ".gui-secret-scope-label",
	privacy: ".gui-secret-private-note",
	insecure: ".gui-secret-insecure",
	field: ".gui-secret-field",
	check: ".gui-secret-check",
	actions: ".gui-ask-summary-actions",
	alts: ".gui-secret-alts",
};

const noop = async (): Promise<void> => {};

/** The card stops at 460px; a state that scrolls or clips shows up as a bound. */
const CARD_BOUND = { "box.w": { min: 300, max: 470 }, "box.h": { min: 60, max: 900 } };

export default {
	"secret-card-fill": {
		async render(root) {
			await mount(
				<SecretCard
					request={{
						requestId: "s1",
						name: "ACME_TOKEN",
						purpose: "Read the ticket that reported this failure.",
						kind: "fill",
						delivery: "env",
					}}
					onAnswer={noop}
				/>,
				root,
			);
		},
		async measure(body) {
			return {
				elements: {
					...measure(body, SELECTORS),
					// The delivery note and the length complaint share one line, so a
					// second paragraph means the copy grew back into two.
					secondNote: readElement(body.querySelectorAll(".gui-note")[1] ?? null),
				},
				notes: countAll(body, ".gui-note"),
				privacyLines: countAll(body, ".gui-secret-private-note"),
			};
		},
		expect: {
			card: CARD_BOUND,
			identity: { display: "flex" },
			// The scope buttons speak for themselves: no sentence repeats the pick
			// (verified by the privacyLines count this scenario reports).
			scope: { display: "grid" },
			actions: { display: "flex" },
		},
	},

	"secret-card-fill-file": {
		async render(root) {
			await mount(
				<SecretCard
					request={{
						requestId: "s1b",
						name: "DEPLOY_KEY",
						purpose: "Sign the release.",
						kind: "fill",
						delivery: "file",
					}}
					onAnswer={noop}
				/>,
				root,
			);
		},
		async measure(body) {
			return { elements: measure(body, SELECTORS), notes: countAll(body, ".gui-note") };
		},
		expect: { card: CARD_BOUND },
	},

	"secret-card-allow": {
		async render(root) {
			await mount(
				<SecretCard
					request={{ requestId: "s3", name: "ACME_TOKEN", purpose: "Read the issue.", kind: "allow" }}
					onAnswer={noop}
				/>,
				root,
			);
		},
		async measure(body) {
			return {
				elements: measure(body, SELECTORS),
				actions: countAll(body, ".gui-ask-summary-actions .gui-btn"),
			};
		},
		expect: {
			card: CARD_BOUND,
			// Allowing is the one thing the buttons cannot explain by themselves.
			privacy: { display: "flex" },
			actions: { display: "flex", "box.h": { max: 80 } },
		},
	},

	"secret-card-login": {
		async render(root) {
			await mount(
				<SecretCard
					request={{
						requestId: "s4",
						name: "IEEE_ACCOUNT",
						purpose: "Sign in to check the submission status.",
						kind: "login",
						site: "author.ieee.org",
					}}
					onAnswer={noop}
				/>,
				root,
			);
		},
		async measure(body) {
			return { elements: measure(body, SELECTORS), fields: countAll(body, ".gui-secret-field") };
		},
		expect: {
			card: CARD_BOUND,
			// The site has its own field; the identity line names the entry only.
			chip: { "box.w": { min: 20, max: 200 } },
			check: { display: "flex" },
			scope: { display: "grid" },
			privacy: { display: "flex" },
		},
	},

	"secret-card-login-alts": {
		async render(root) {
			await mount(
				<SecretCard
					request={{
						requestId: "s5",
						name: "IEEE_ACCOUNT",
						purpose: "Sign in to check the submission status.",
						kind: "login",
						site: "author.ieee.org",
						alternatives: [{ name: "IEEE_OLD", purpose: "old", site: "author.ieee.org", username: "linm" }],
					}}
					onAnswer={noop}
				/>,
				root,
			);
		},
		async measure(body) {
			return { elements: measure(body, SELECTORS), chips: countAll(body, ".gui-secret-alt-chip") };
		},
		expect: { card: CARD_BOUND, alts: { display: "flex" } },
	},

	"secret-card-replace": {
		async render(root) {
			await mount(
				<SecretCard
					request={{ requestId: "s3b", name: "ACME_TOKEN", purpose: "Read the issue.", kind: "allow" }}
					onAnswer={noop}
				/>,
				root,
			);
			// Pressing Replace value turns the same card into the fill state.
			await clickText(root, "button", "替换值");
		},
		async measure(body) {
			return {
				elements: measure(body, SELECTORS),
				// Nothing to measure means no scope pick: the absence itself is the
				// contract, verified by the test that asserts no scope is sent.
				scopePicks: countAll(body, ".gui-secret-scope"),
			};
		},
		expect: {
			card: CARD_BOUND,
			// Replacing is a fill card now, but the grant is not on the table.
			privacy: { display: "flex" },
			actions: { display: "flex", "box.h": { max: 80 } },
		},
	},

	"secret-card-narrow": {
		async render(root) {
			root.style.maxWidth = "320px";
			await mount(
				<SecretCard
					request={{
						requestId: "s6",
						name: "IEEE_ACCOUNT",
						purpose: "Sign in to check the submission status of TAES-2026-5714.",
						kind: "login",
						site: "author.ieee.org",
					}}
					onAnswer={noop}
				/>,
				root,
			);
		},
		async measure(body) {
			return { elements: measure(body, SELECTORS) };
		},
		expect: {
			// A narrow column must shrink the card, not squeeze it into a stack.
			card: { "box.w": { min: 260, max: 330 } },
			scope: { display: "grid" },
		},
	},
} satisfies Record<string, GuiScenario>;
