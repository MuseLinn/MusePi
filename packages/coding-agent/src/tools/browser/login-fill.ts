/**
 * Type a saved login into the page the browser tool is showing — without the
 * values ever reaching the agent.
 *
 * The browser tool's `run` path executes model-authored code, so a password
 * cannot travel through it: anything the code can read, the model can print.
 * This module therefore drives the page from the daemon's own CDP connection,
 * typed by us and never serialized into a tool result.
 *
 * The heuristic fills the three fields a sign-in form has — a username or
 * email input, a password input, and an optional one-time-code input — using
 * the labels and `autocomplete` hints a page already publishes. It refuses to
 * guess: a form with no password input is reported as such instead of typing a
 * password into a search box.
 */

export interface LoginFillValues {
	username: string;
	password: string;
	/** A current TOTP code, when the entry has a setup key. */
	code?: string;
}

export interface LoginFillReport {
	/** Field roles actually typed. */
	filled: Array<"username" | "password" | "code">;
	/** A submit control was clicked after typing. */
	submitted: boolean;
	/** What could not be done, in the words the agent should relay. */
	problem?: string;
}

/** The in-page script; runs in the page, returns what it typed. */
const FILL_SCRIPT = `(values) => {
	const isVisible = el => {
		const rect = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
	};
	const inputs = [...document.querySelectorAll("input")].filter(isVisible);
	const autocomplete = el => (el.getAttribute("autocomplete") ?? "").toLowerCase();
	const byAutocomplete = (...wanted) => inputs.find(el => wanted.some(w => autocomplete(el).includes(w)));
	const looksLike = (el, words) => {
		const hay = [el.name, el.id, el.placeholder, el.getAttribute("aria-label")]
			.filter(Boolean).join(" ").toLowerCase();
		return words.some(w => hay.includes(w));
	};
	const password = byAutocomplete("current-password", "password") ??
		inputs.find(el => el.type === "password");
	if (!password) return { filled: [], submitted: false, problem: "This page has no password field." };
	const username = byAutocomplete("username", "email") ??
		inputs.find(el => el.type === "email") ??
		inputs.find(el => el.type === "text" && looksLike(el, ["user", "email", "login", "account"]));
	const code = byAutocomplete("one-time-code") ??
		inputs.find(el => looksLike(el, ["otp", "code", "totp", "2fa"]));
	const set = (el, value) => {
		if (!el || !value) return false;
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
		setter.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
		return true;
	};
	const filled = [];
	if (set(username, values.username)) filled.push("username");
	if (set(password, values.password)) filled.push("password");
	if (set(code, values.code)) filled.push("code");
	let submitted = false;
	const submit = password.form?.querySelector('button[type="submit"], input[type="submit"]') ??
		[...document.querySelectorAll("button")].find(b => /sign in|log in|continue|next/i.test(b.textContent ?? "") && isVisible(b));
	if (submit) { submit.click(); submitted = true; }
	return { filled, submitted, ...(values.code && !filled.includes("code") ? { problem: "No one-time-code field was found; the page may ask for it on a later step." } : {}) };
}`;

/**
 * Connect to the tab's CDP endpoint, run {@link FILL_SCRIPT} in its page, and
 * disconnect. The values live only in this process and in the page's DOM.
 */
export async function fillLoginIntoPage(cdpUrl: string, values: LoginFillValues): Promise<LoginFillReport> {
	const { default: puppeteer } = await import("puppeteer-core");
	const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
	try {
		const pages = await browser.pages();
		const page = pages.find(candidate => candidate.url() && candidate.url() !== "about:blank") ?? pages[0];
		if (!page) return { filled: [], submitted: false, problem: "This browser has no open page." };
		const report = (await page.evaluate(
			FILL_SCRIPT,
			values as unknown as Record<string, unknown>,
		)) as LoginFillReport;
		// The code is single-use and short-lived; the password stays only as long
		// as the field holds it, which is what a form is for.
		return report;
	} finally {
		// `disconnect` leaves the user's browser running; only our link drops.
		await browser.disconnect().catch(() => {});
	}
}
