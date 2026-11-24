/**
 * Exact-value redaction for local sinks that never go through a provider or a
 * bash child: memory writes, for example, persist text verbatim. Heuristic
 * credential detection misses a short or unremarkable saved value, so every
 * stored agent secret registers its byte forms here and the sink replaces the
 * exact text with `[REDACTED]`.
 *
 * Registrations live for the process: deleting a secret must not stop scrubbing
 * a value that may already sit in a file.
 */

import { secretForms } from "./forms";

const exact = new Set<string>();

/** Register one value's raw, JSON-escaped and URL-encoded forms. */
export function registerExactSecret(value: string): void {
	if (value.length === 0) return;
	for (const form of secretForms(value)) exact.add(form);
}

/** Replace every registered value form with `[REDACTED]`; longest form first. */
export function redactExactSecrets(input: string): string {
	if (exact.size === 0 || input.length === 0) return input;
	let output = input;
	const forms = [...exact].sort((left, right) => right.length - left.length);
	for (const form of forms) {
		if (output.includes(form)) output = output.split(form).join("[REDACTED]");
	}
	return output;
}

/** Test-only: forget every exact value. */
export function clearExactSecretsForTests(): void {
	exact.clear();
}
