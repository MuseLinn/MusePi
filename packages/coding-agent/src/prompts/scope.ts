/**
 * Prompt scope chains.
 *
 * A scope is an immutable node. Contributions registered in an ancestor are
 * inherited by every descendant; registering the same name in a descendant
 * shadows the ancestor until the descendant registration is disposed.
 */
import type { PromptScope } from "./types";

export function createPromptScope(name: string, parent: PromptScope | null = null): PromptScope {
	if (typeof name !== "string" || name.length === 0) {
		throw new TypeError("prompt scope: name is required");
	}
	return Object.freeze({ name, parent, depth: parent ? parent.depth + 1 : 0 });
}

/** Walk a scope from the leaf to the root. */
export function promptScopeChain(scope: PromptScope): PromptScope[] {
	const chain: PromptScope[] = [];
	for (let current: PromptScope | null = scope; current; current = current.parent) {
		chain.push(current);
	}
	return chain;
}

/** True when `candidate` is `view` itself or one of its ancestors. */
export function promptScopeContains(view: PromptScope, candidate: PromptScope): boolean {
	for (let current: PromptScope | null = view; current; current = current.parent) {
		if (current === candidate) return true;
	}
	return false;
}
