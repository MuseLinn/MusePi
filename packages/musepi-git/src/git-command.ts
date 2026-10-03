import type { ExtensionAPI } from "@musepi/pi-coding-agent";
import { formatRepoState } from "./format.ts";
import { readRepoState } from "./repo-state.ts";

/**
 * `/git` — report the repository state of the session's working directory.
 *
 * Read-only and side-effect free, so it is safe to run mid-turn. The reply is
 * `sendMessage` text rather than printed output: a slash command that returns a
 * string lands in the transcript, where the next turn can read it.
 */
export default function registerGitCommand(pi: ExtensionAPI): void {
	pi.registerCommand("git", {
		description: "Show branch, HEAD shape and working-tree counts for this session's directory",
		handler: async (_args, ctx) => {
			const cwd = ctx?.cwd;
			if (!cwd) {
				await pi.sendMessage("git: no working directory on this session", {
					triggerTurn: false,
				});
				return;
			}
			const state = await readRepoState(cwd);
			await pi.sendMessage(`git: ${formatRepoState(state)}`, {
				triggerTurn: false,
			});
		},
	});
}
