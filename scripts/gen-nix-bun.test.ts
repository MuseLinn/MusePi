import { describe, expect, test } from "bun:test";
import { BUN2NIX_NPM_SPEC, resolveNixBunDepsGenerator } from "./gen-nix-bun";

describe("resolveNixBunDepsGenerator", () => {
	test("prefers bun2nix from the active development shell", () => {
		const generator = resolveNixBunDepsGenerator(command => {
			if (command === "bun2nix") return "/nix/store/bun2nix";
			return "/nix/store/nix";
		});

		expect(generator).toEqual({ kind: "bun2nix", executable: "/nix/store/bun2nix" });
	});

	test("falls back to entering the Nix development shell", () => {
		const generator = resolveNixBunDepsGenerator(command => (command === "nix" ? "/usr/bin/nix" : null));

		expect(generator).toEqual({ kind: "nix", executable: "/usr/bin/nix" });
	});

	test("falls back to the pinned portable bunx package", () => {
		expect(resolveNixBunDepsGenerator(() => null)).toEqual({
			kind: "bunx",
			package: BUN2NIX_NPM_SPEC,
		});
	});
});
