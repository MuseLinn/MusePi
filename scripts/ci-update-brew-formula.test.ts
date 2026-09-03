import { describe, expect, it } from "bun:test";
import { renderFormula } from "./ci-update-brew-formula";

const SUMS = {
	"musepi-darwin-arm64": "darwin_arm64_sha",
	"musepi-linux-arm64": "linux_arm64_sha",
	"musepi-linux-x64": "linux_x64_sha",
};

describe("renderFormula", () => {
	const formula = renderFormula("15.12.1", SUMS);

	// Regression: bare-binary URLs must opt out of Homebrew's UnpackStrategy.
	// Without `using: :nounzip` the default CurlDownloadStrategy nests the file
	// outside the staging CWD, `Dir["musepi-*"].first` returns `nil`, and
	// `bin.install nil => "musepi"` raises (issue #2398).
	it("attaches `using: :nounzip` to every per-platform url stanza", () => {
		const matches = formula.match(/using: :nounzip/g) ?? [];
		expect(matches).toHaveLength(3);
		for (const arch of ["musepi-darwin-arm64", "musepi-linux-arm64", "musepi-linux-x64"]) {
			expect(formula).toMatch(
				new RegExp(
					`url "https://github\\.com/[^"]+/${arch}",\\s+using: :nounzip\\s+sha256 "${SUMS[arch as keyof typeof SUMS]}"`,
				),
			);
		}
	});

	// Regression: completions generation must run with HOME redirected so the
	// popened binary doesn't touch the real `~/.musepi` (denied by Homebrew's
	// sandbox profile) during the build (issue #2398).
	it("wraps `generate_completions_from_executable` with a HOME redirect to buildpath", () => {
		expect(formula).toMatch(
			/with_env\(HOME: buildpath\) do\n\s+generate_completions_from_executable\(bin\/"musepi", "completions", shells: \[:bash, :zsh, :fish\]\)\n\s+end/,
		);
		// And the bare form (which is what failed in the sandbox) must not appear
		// outside the `with_env` block.
		const blockless = formula.replace(/with_env\(HOME: buildpath\) do[\s\S]*?end/, "");
		expect(blockless).not.toMatch(/generate_completions_from_executable/);
	});

	it("emits the expected per-asset sha256 next to each url", () => {
		for (const name in SUMS) {
			const sha = SUMS[name as keyof typeof SUMS];
			expect(formula).toContain(`/${name}",`);
			expect(formula).toContain(`sha256 "${sha}"`);
		}
	});
});
