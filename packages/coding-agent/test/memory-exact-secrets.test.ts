import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactMemorySecrets } from "@musepi/pi-coding-agent/memory-backend/redact";
import { notifyAgentSecretSaved } from "@musepi/pi-coding-agent/secrets/agent-runtime";
import { clearExactSecretsForTests, registerExactSecret } from "@musepi/pi-coding-agent/secrets/exact-guard";

afterEach(() => {
	clearExactSecretsForTests();
});

describe("exact redaction for local sinks", () => {
	it("redacts a saved value the heuristic would miss", () => {
		registerExactSecret("abc-def-123");
		expect(redactMemorySecrets("remember abc-def-123 for later")).toContain("[REDACTED]");
	});

	it("covers the encoded forms of a registered value", () => {
		registerExactSecret("tok/with+slash");
		expect(redactMemorySecrets("url?t=tok%2Fwith%2Bslash")).toContain("[REDACTED]");
	});

	it("registers a value saved through the secret store", () => {
		const dir = mkdtempSync(join(tmpdir(), "musepi-exact-secret-"));
		notifyAgentSecretSaved(dir, "API_TOKEN", "short-value-9");
		expect(redactMemorySecrets("value short-value-9")).toContain("[REDACTED]");
	});
});
