import { $ } from "bun";

export async function resolveCargoBinary(cwd: string): Promise<string> {
	const result = await $`rustup which cargo`.cwd(cwd).quiet().nothrow();
	if (result.exitCode === 0) {
		const resolved = result.stdout.toString().trim();
		if (resolved !== "") return resolved;
	}
	return "cargo";
}
