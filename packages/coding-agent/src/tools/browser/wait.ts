import { ToolError } from "../tool-errors";

export type PageCondition =
	| {
			kind: "element";
			locator: { role: string; name?: string; exact?: boolean };
			state: "visible" | "hidden" | "enabled";
	  }
	| {
			kind: "text";
			text: string;
			match?: "exact" | "contains";
			state: "present" | "absent";
	  }
	| {
			kind: "url";
			value: string;
			match: "exact" | "prefix";
	  };

export interface BrowserWaitResult {
	outcome: "matched" | "timeout";
	condition: PageCondition;
	lastObserved: unknown;
	timeoutMs: number;
}

export function pageWaitCode(condition: PageCondition, timeoutMs = 10_000, stableForMs = 0): string {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
		throw new ToolError("wait_for timeoutMs must be between 1 and 30000");
	}
	if (!Number.isInteger(stableForMs) || stableForMs < 0 || stableForMs > 5000) {
		throw new ToolError("wait_for stableForMs must be between 0 and 5000");
	}
	return `const deadline = Date.now() + ${timeoutMs};
const stableForMs = ${stableForMs};
const condition = ${JSON.stringify(condition)};
let stableSince = null;
let lastObserved;
while (true) {
	const current = await tab.evaluate(async condition => {
		const roleOf = element => {
			const explicit = element.getAttribute("role");
			if (explicit) return explicit;
			const tag = element.tagName.toLowerCase();
			if (tag === "button" || tag === "input" || tag === "select" || tag === "textarea") return tag === "input" ? element.type : tag;
			if (tag === "a") return "link";
			if (tag === "img") return "img";
			if (tag === "form") return "form";
			return tag;
		};
		const nameOf = element => [element.getAttribute("aria-label"), element.getAttribute("alt"), element.value, element.title, element.textContent]
			.filter(value => typeof value === "string" && value.trim())
			.map(value => value.trim().replace(/s+/g, " "))
			.join(" ");
		const rendered = element => {
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && rect.width > 0 && rect.height > 0;
		};
		if (condition.kind === "element") {
			const matches = Array.from(document.querySelectorAll("*")).filter(element => {
				if (roleOf(element) !== condition.locator.role) return false;
				if (!condition.locator.name) return true;
				const name = nameOf(element);
				return condition.locator.exact ? name === condition.locator.name : name.includes(condition.locator.name);
			}).filter(rendered);
			const observed = {
				count: matches.length,
				examples: matches.slice(0, 3).map(element => ({ role: roleOf(element), name: nameOf(element).slice(0, 120) })),
			};
			if (condition.state === "hidden") return { matched: matches.length === 0, observed };
			if (condition.state === "enabled") {
				return {
					matched: matches.some(element => !element.disabled && element.getAttribute("aria-disabled") !== "true"),
					observed,
				};
			}
			return { matched: matches.length > 0, observed };
		}
		if (condition.kind === "text") {
			const content = document.body?.innerText ?? "";
			const present = condition.match === "exact" ? content.trim() === condition.text : content.includes(condition.text);
			return {
				matched: condition.state === "absent" ? !present : present,
				observed: { text: content.slice(0, 500), present },
			};
		}
		const href = location.href;
		return {
			matched: condition.match === "prefix" ? href.startsWith(condition.value) : href === condition.value,
			observed: { url: href },
		};
	}, condition);
	lastObserved = current.observed;
	if (current.matched) {
		if (stableSince === null) stableSince = Date.now();
		if (Date.now() - stableSince >= stableForMs) {
			return { outcome: "matched", condition, lastObserved, timeoutMs: ${timeoutMs} };
		}
	} else {
		stableSince = null;
	}
	if (Date.now() >= deadline) break;
	await wait(50);
}
return { outcome: "timeout", condition, lastObserved, timeoutMs: ${timeoutMs} };`;
}
