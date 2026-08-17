#!/usr/bin/env bun

import * as path from "node:path";
import { $ } from "bun";
import { $which } from "../packages/utils/src/which";

const repoRoot = path.join(import.meta.dir, "..");

/** Pinned npm package matching flake.lock's bun2nix revision (`0f2a1f…`). */
export const BUN2NIX_NPM_SPEC = "bun2nix@2.1.2";

type FindExecutable = (command: string) => string | null;

/** The executable path and invocation mode for the pinned Bun dependency generator. */
export type NixBunDepsGenerator =
	| { kind: "bun2nix"; executable: string }
	| { kind: "nix"; executable: string }
	| { kind: "bunx"; package: typeof BUN2NIX_NPM_SPEC };

/** Resolve the generator needed by releases before they mutate repository state. */
export function resolveNixBunDepsGenerator(findExecutable: FindExecutable = $which): NixBunDepsGenerator {
	const bun2nix = findExecutable("bun2nix");
	if (bun2nix) return { kind: "bun2nix", executable: bun2nix };

	const nix = findExecutable("nix");
	if (nix) return { kind: "nix", executable: nix };

	return { kind: "bunx", package: BUN2NIX_NPM_SPEC };
}

/** Regenerate the checked-in Bun dependency expression with the pinned bun2nix input. */
export async function generateNixBunDeps(generator: NixBunDepsGenerator = resolveNixBunDepsGenerator()): Promise<void> {
	if (generator.kind === "bun2nix") {
		await $`${generator.executable} -l bun.lock -c ../ -o nix/bun.nix`.cwd(repoRoot);
		return;
	}
	if (generator.kind === "nix") {
		await $`${generator.executable} --extra-experimental-features ${"nix-command flakes"} --accept-flake-config develop --command bun2nix -l bun.lock -c ../ -o nix/bun.nix`.cwd(
			repoRoot,
		);
		return;
	}

	await $`bunx ${generator.package} -l bun.lock -c ../ -o nix/bun.nix`.cwd(repoRoot);
}

if (import.meta.main) await generateNixBunDeps();
