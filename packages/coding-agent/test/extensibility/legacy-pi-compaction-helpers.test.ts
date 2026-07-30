import { describe, expect, it } from "bun:test";
import { estimateTokens } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

// Issue #6583: pi extensions import `estimateTokens` from
// `@earendil-works/pi-coding-agent`, which aliases to this shim. Legacy pi
// re-exported it from the coding-agent package root (via
// `./core/compaction/index.ts`); in omp it lives in
// `@oh-my-pi/pi-agent-core/compaction` and the coding-agent barrel does not
// forward it, so `export * from "../index"` left the symbol off the shim
// surface and a named import threw Bun's static "Export named X not found"
// during plugin validation (e.g. `omp plugin install pi-blackhole`). This pins
// the re-export through the public package specifier.
describe("legacy shim compaction helpers", () => {
	it("re-exports estimateTokens as a callable token estimator", () => {
		expect(typeof estimateTokens).toBe("function");
		const tokens = estimateTokens({ role: "user", content: "hello world", timestamp: Date.now() });
		expect(tokens).toBeGreaterThan(0);
	});
});
