import { getOAuthProviders } from "@musepi/pi-ai/oauth";
import { settings } from "../config/settings";
import { t } from "../i18n/index.js";
import type { AgentSession } from "../session/agent-session";
import type { SessionOAuthAccountList } from "../session/agent-session-types";
import {
	getChangelogPath,
	parseChangelog,
	RECENT_CHANGELOG_ENTRY_LIMIT,
	renderChangelogEntries,
} from "../utils/changelog";
import { formatTokenCount, refreshStatusLine } from "./builtin-modes";
import { buildContextReportText } from "./helpers/context-report";
import { formatDuration } from "./helpers/format";
import { handleMcpAcp } from "./helpers/mcp";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import { describeRedeemOutcome, type ResetUsageAccount, toResetUsageAccounts } from "./helpers/reset-usage";
import { matchSessionPinAccounts, toSessionPinAccounts } from "./helpers/session-pin";
import { launchStatsDashboard, parseStatsDashboardArgs } from "./helpers/stats-dashboard";
import { handleTodoAcp } from "./helpers/todo";
import { buildUsageReportText } from "./helpers/usage-report";
import type { SlashCommandRuntime, SlashCommandSpec } from "./types";

async function handleUsageResetCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	let accounts: ResetUsageAccount[];
	try {
		accounts = toResetUsageAccounts(await session.listResetCredits());
	} catch (error) {
		await output(`Could not load saved resets: ${errorMessage(error)}`);
		return;
	}
	if (accounts.length === 0) {
		await output("No Codex accounts found. Use /login to add one.");
		return;
	}
	const targetArg = arg.trim();
	if (!targetArg) {
		const lines = ["Saved Codex rate-limit resets:"];
		for (const account of accounts) {
			const detail = account.error ? `unavailable (${account.error})` : `${account.availableCount} available`;
			lines.push(`- ${account.label}: ${detail}${account.active ? " (active)" : ""}`);
		}
		lines.push("", "Spend one with `/usage reset <account email>` or `/usage reset active`.");
		await output(lines.join("\n"));
		return;
	}
	const wanted = targetArg.toLowerCase();
	const target =
		wanted === "active"
			? accounts.find(account => account.active)
			: accounts.find(
					account =>
						account.label.toLowerCase() === wanted ||
						account.target.email?.toLowerCase() === wanted ||
						account.target.accountId?.toLowerCase() === wanted,
				);
	if (!target) {
		await output(`No Codex account matches "${targetArg}".`);
		return;
	}
	if (target.availableCount <= 0) {
		await output(`${target.label}: no saved resets to spend.`);
		return;
	}
	const outcome = await session.redeemResetCredit(target.target);
	await output(describeRedeemOutcome(outcome, target.label));
}

async function handleSessionPinCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	if (session.isStreaming) {
		await output("Cannot pin an account while the session is streaming.");
		return;
	}
	let accountList: SessionOAuthAccountList | undefined;
	try {
		accountList = await session.listCurrentProviderOAuthAccounts();
	} catch (error) {
		await output(`Could not load provider accounts: ${errorMessage(error)}`);
		return;
	}
	if (!accountList) {
		await output("Select a model before pinning a provider account.");
		return;
	}
	const provider = getOAuthProviders().find(candidate => candidate.id === accountList.provider);
	const providerName = provider?.name ?? accountList.provider;
	const accounts = toSessionPinAccounts(accountList.accounts);
	if (accounts.length === 0) {
		const source = session.modelRegistry.authStorage.describeCredentialSource(
			accountList.provider,
			session.sessionId,
		);
		await output(
			source
				? `No stored OAuth accounts for ${providerName}. Current auth comes from ${source}.`
				: `No stored OAuth accounts for ${providerName}. Use /login to add one.`,
		);
		return;
	}

	const selector = arg.trim();
	if (!selector) {
		const lines = [`OAuth accounts for ${providerName}:`];
		for (const account of accounts) {
			lines.push(`${account.position + 1}. ${account.label}${account.active ? " (active)" : ""}`);
		}
		lines.push("", "Pin one with `/session pin <number|email|account id>`.");
		await output(lines.join("\n"));
		return;
	}

	const matches = matchSessionPinAccounts(accounts, selector);
	if (matches.length === 0) {
		await output(`No ${providerName} account matches "${selector}".`);
		return;
	}
	if (matches.length > 1) {
		await output(
			`"${selector}" matches multiple ${providerName} accounts: ${matches
				.map(account => `${account.position + 1}. ${account.label}`)
				.join(", ")}. Use the account number.`,
		);
		return;
	}
	const account = matches[0];
	if (!account || !session.pinCurrentProviderOAuthAccount(account.credentialId)) {
		await output(`${account?.label ?? selector} is no longer available to pin.`);
		return;
	}
	await output(`Pinned ${account.label} to this session for ${providerName}.`);
}

/**
 * Render a "<Prefix>: <state>" autocomplete status line, translating both
 * parts at render time (the locale is applied after this module loads and can
 * change at runtime). Pass already-translated or dynamic text as `state`.
 */
const statusLine = (prefix: string, state: string): string => `${t(prefix)}: ${state}`;

export const BUILTIN_SESSION_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "todo",
		description: "View or modify the agent's todo list",
		acpDescription: "Manage todos",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "edit", description: "Open todos in $EDITOR (Markdown round-trip)" },
			{ name: "copy", description: "Copy todos as Markdown to clipboard" },
			{ name: "export", description: "Write todos as Markdown to a file (default: TODO.md)", usage: "[<path>]" },
			{ name: "import", description: "Replace todos from a Markdown file (default: TODO.md)", usage: "[<path>]" },
			{
				name: "append",
				description: "Append a task; phase fuzzy-matched or auto-created",
				usage: "[<phase>] <task...>",
			},
			{ name: "start", description: "Mark task in_progress (fuzzy-matched)", usage: "<task>" },
			{ name: "done", description: "Mark task/phase/all completed (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "drop", description: "Mark task/phase/all abandoned (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "rm", description: "Remove task/phase/all (fuzzy-matched)", usage: "[<task|phase>]" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const tasks = runtime.ctx.todoPhases.flatMap(phase => phase.tasks);
			if (tasks.length === 0) return statusLine("Todos", t("none"));
			const pending = tasks.filter(task => task.status === "pending").length;
			const inProgress = tasks.filter(task => task.status === "in_progress").length;
			const completed = tasks.filter(task => task.status === "completed").length;
			return statusLine(
				"Todos",
				`${pending + inProgress} ${t("open")} (${inProgress} ${t("in progress")}, ${completed} ${t("done")})`,
			);
		},

		handle: handleTodoAcp,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "session",
		description: "Session management commands",
		acpDescription: "Show or configure the current session",
		acpInputHint: "[info|delete|pin [account]]",
		subcommands: [
			{ name: "info", description: "Show session info and stats" },
			{ name: "delete", description: "Delete current session and return to selector" },
			{
				name: "pin",
				description: "Pin the current provider to a stored OAuth account",
				usage: "[account]",
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "info" && !rest)) {
				await runtime.output(
					[
						`Session: ${runtime.session.sessionId}`,
						`Title: ${runtime.session.sessionName}`,
						`CWD: ${runtime.cwd}`,
					].join("\n"),
				);
				return commandConsumed();
			}
			if (verb === "delete" && !rest) {
				if (runtime.session.isStreaming) return usage("Cannot delete the session while streaming.", runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage("No session file to delete (in-memory session).", runtime);
				// Route through the active SessionManager so the persist writer is
				// closed before the file is deleted. Constructing a fresh
				// FileSessionStorage and calling deleteSessionWithArtifacts leaves
				// the active writer attached to the now-deleted path, so the next
				// prompt would silently resurrect or corrupt the "deleted" file.
				try {
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(`Failed to delete session: ${errorMessage(err)}`, runtime);
				}
				await runtime.output(
					`Session deleted: ${sessionFile}. Use ACP \`session/load\` to switch to another session.`,
				);
				return commandConsumed();
			}
			if (verb === "pin") {
				await handleSessionPinCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage("Usage: /session [info|delete|pin [account]]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "delete" && !rest) {
				runtime.ctx.editor.setText("");
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			if (verb === "pin") {
				if (rest) {
					await handleSessionPinCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
					refreshStatusLine(runtime.ctx);
				} else {
					await runtime.ctx.showSessionPinSelector();
				}
				runtime.ctx.editor.setText("");
				return;
			}
			if (!verb || (verb === "info" && !rest)) {
				await runtime.ctx.handleSessionCommand();
			} else {
				runtime.ctx.showStatus("Usage: /session [info|delete|pin [account]]");
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "jobs",
		description: "Show async background jobs status",
		acpDescription: "Show background jobs",
		getTuiAutocompleteDescription: runtime => {
			const snapshot = runtime.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0))
				return statusLine("Jobs", t("none"));
			return statusLine(
				"Jobs",
				`${snapshot.running.length} ${t("running")}, ${snapshot.recent.length} ${t("recent")}`,
			);
		},

		handle: async (_command, runtime) => {
			const snapshot = runtime.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) {
				await runtime.output(
					"No background jobs running. (Background jobs run async tools — e.g. long-running bash, debug, or task subagents that would otherwise tie up a turn. They appear here while alive and for ~5 minutes after.)",
				);
				return commandConsumed();
			}
			const now = Date.now();
			const lines: string[] = ["Background Jobs", `Running: ${snapshot.running.length}`];
			if (snapshot.running.length > 0) {
				lines.push("", "Running Jobs");
				for (const job of snapshot.running) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			if (snapshot.recent.length > 0) {
				lines.push("", "Recent Jobs");
				for (const job of snapshot.recent) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleJobsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "usage",
		description: "Show provider usage and limits",
		acpDescription: "Show token usage",
		acpInputHint: "[show|reset [account|active]]",
		subcommands: [
			{ name: "show", description: "Show provider usage and limits" },
			{ name: "reset", description: "Spend a saved Codex rate-limit reset", usage: "[account|active]" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.output(await buildUsageReportText(runtime));
				return commandConsumed();
			}
			if (verb === "reset") {
				await handleUsageResetCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage("Usage: /usage [show|reset [account|active]]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.ctx.handleUsageCommand();
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "reset") {
				if (rest) {
					await handleUsageResetCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
				} else {
					await runtime.ctx.showResetUsageSelector();
				}
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /usage [show|reset [account|active]]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "stats",
		description: "Launch the local stats dashboard",
		inlineHint: "[--port <port>] [--host <host>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);

			await runtime.output("Syncing session files...");
			try {
				const result = await launchStatsDashboard(parsed);
				await runtime.output(result.message);
			} catch (error) {
				await runtime.output(`Stats dashboard failed: ${errorMessage(error)}`);
			}
			return commandConsumed();
		},
	},
	{
		name: "changelog",
		description: "Show changelog entries",
		acpDescription: "Show changelog",
		acpInputHint: "[full]",
		subcommands: [{ name: "full", description: "Show complete changelog" }],
		allowArgs: true,
		handle: async (command, runtime) => {
			const changelogPath = getChangelogPath();
			const allEntries = await parseChangelog(changelogPath);
			const showFull = command.args.trim().toLowerCase() === "full";
			const entriesToShow = showFull ? allEntries : allEntries.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT);
			if (entriesToShow.length === 0) {
				await runtime.output("No changelog entries found.");
				return commandConsumed();
			}
			await runtime.output(renderChangelogEntries(entriesToShow).markdown);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const showFull = command.args.split(/\s+/).filter(Boolean).includes("full");
			await runtime.ctx.handleChangelogCommand(showFull);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "hotkeys",
		description: "Show all keyboard shortcuts",
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tools",
		description: "Show tools currently visible to the agent",
		acpDescription: "Show available tools",
		getTuiAutocompleteDescription: runtime => {
			const active = runtime.ctx.session.getActiveToolNames().length;
			const all = runtime.ctx.session.getAllToolNames().length;
			return all === 0
				? statusLine("Tools", t("none available"))
				: statusLine("Tools", `${active} ${t("active")} / ${all} ${t("available")}`);
		},

		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output("No tools are available.");
				return commandConsumed();
			}
			const lines = all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`);
			for (const mounted of runtime.session.getXdevToolEntries()) {
				lines.push(`~ xd://${mounted.name}`);
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "context",
		description: "Show estimated context usage breakdown",
		acpDescription: "Show context usage",
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			if (!usage) return statusLine("Context", t("unavailable"));
			return statusLine(
				"Context",
				`${Math.round(usage.percent)}% (${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)})`,
			);
		},

		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "extensions",
		aliases: ["status"],
		description: "Open Extension Control Center dashboard",
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "agents",
		description: "Open the agents hub (per-agent model, prewalk, and advisor)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "branch",
		description: "Create a new branch from a previous message",
		handleTui: (_command, runtime) => {
			if (settings.get("doubleEscapeAction") === "tree") {
				runtime.ctx.showTreeSelector();
			} else {
				runtime.ctx.showUserMessageSelector();
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fork",
		description: "Fork the session into a new file (same conversation)",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		description: "Navigate session tree (switch branches)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "login",
		description: "Login with OAuth provider",
		inlineHint: "[provider|redirect URL]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.oauthManualInput.hasPending()
				? statusLine(
						"Login",
						t("waiting for {0} callback", runtime.ctx.oauthManualInput.pendingProviderId ?? "OAuth"),
					)
				: statusLine("Login", t("choose provider")),

		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? `OAuth login already in progress for ${pendingProvider}. Paste the redirect URL with /login <url>.`
							: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
						runtime.ctx.showWarning(message);
						runtime.ctx.editor.setText("");
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					runtime.ctx.editor.setText("");
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus("OAuth callback received; completing login…");
				} else {
					runtime.ctx.showWarning("No OAuth login is waiting for a manual callback.");
				}
				runtime.ctx.editor.setText("");
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? `OAuth login already in progress for ${provider}. Paste the redirect URL with /login <url>.`
					: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
				runtime.ctx.showWarning(message);
				runtime.ctx.editor.setText("");
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "logout",
		description: "Logout from OAuth provider",
		inlineHint: "[provider]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const providerId = command.args.trim();
			if (providerId) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === providerId);
				if (!matchedProvider) {
					runtime.ctx.showWarning(`Unknown OAuth provider: ${providerId}`);
					runtime.ctx.editor.setText("");
					return;
				}
				void runtime.ctx.showOAuthSelector("logout", matchedProvider.id);
				runtime.ctx.editor.setText("");
				return;
			}
			void runtime.ctx.showOAuthSelector("logout");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "mcp",
		description: "Manage MCP servers (add, list, remove, test)",
		acpDescription: "Manage MCP servers",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add a new MCP server",
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: "List all configured MCP servers" },
			{ name: "remove", description: "Remove an MCP server", usage: "<name> [--scope project|user]" },
			{ name: "test", description: "Test connection to a server", usage: "<name>" },
			{ name: "reauth", description: "Reauthorize OAuth for a server", usage: "<name>" },
			{ name: "unauth", description: "Remove OAuth auth from a server", usage: "<name>" },
			{ name: "enable", description: "Enable an MCP server", usage: "<name>" },
			{ name: "disable", description: "Disable an MCP server", usage: "<name>" },
			{
				name: "smithery-search",
				description: "Search Smithery registry and deploy an MCP server",
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			},
			{ name: "smithery-login", description: "Login to Smithery and cache API key" },
			{ name: "smithery-logout", description: "Remove cached Smithery API key" },
			{ name: "reconnect", description: "Reconnect to a specific MCP server", usage: "<name>" },
			{ name: "reload", description: "Force reload MCP runtime tools" },
			{ name: "resources", description: "List available resources from connected servers" },
			{ name: "prompts", description: "List available prompts from connected servers" },
			{ name: "notifications", description: "Show notification capabilities and subscriptions" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleMcpAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
	{
		name: "search",
		description: "Cross-session message search (GUI ⌘K parity)",
		acpDescription: "Search the query across all sessions' transcripts",
		acpInputHint: "<query>",
		allowArgs: true,
		handle: async (command, runtime) => {
			const query = command.args.trim();
			if (!query) {
				await runtime.output("Usage: /search <query>");
				return;
			}
			const { SessionManager } = await import("../session/session-manager");
			const all = await SessionManager.listAll();
			// newest first, bounded to 200 sessions to keep the scan cheap
			const sorted = all.sort((a, b) => b.modified.getTime() - a.modified.getTime()).slice(0, 200);
			const lower = query.toLowerCase();
			const matches: Array<{ id: string; title: string; firstMessage: string; modified: Date }> = [];
			for (const s of sorted) {
				if (s.allMessagesText.toLowerCase().includes(lower)) {
					matches.push({
						id: s.id,
						title: s.title ?? s.firstMessage.slice(0, 60),
						firstMessage: s.firstMessage.slice(0, 120),
						modified: s.modified,
					});
				}
			}
			if (matches.length === 0) {
				await runtime.output(`No sessions match "${query}".`);
				return;
			}
			const lines = [`Cross-session search "${query}": ${matches.length} match(es)`];
			for (const m of matches) {
				const ts = m.modified.toISOString().slice(0, 16).replace("T", " ");
				lines.push(`- ${ts}  ${m.id}  ${m.title}`);
			}
			lines.push("", "Open a session to inspect it. (GUI: ⌘K does live search.)");
			await runtime.output(lines.join("\n"));
		},
		handleTui: async (command, runtime) => {
			const query = command.args.trim();
			if (!query) {
				runtime.ctx.showStatus("Usage: /search <query>");
				return;
			}
			runtime.ctx.showStatus(`Searching sessions for "${query}"…`);
			const { SessionManager } = await import("../session/session-manager");
			const all = await SessionManager.listAll();
			const sorted = all.sort((a, b) => b.modified.getTime() - a.modified.getTime()).slice(0, 200);
			const lower = query.toLowerCase();
			const matches = sorted.filter(s => s.allMessagesText.toLowerCase().includes(lower));
			if (matches.length === 0) {
				runtime.ctx.showStatus(`No sessions match "${query}".`);
				return;
			}
			const lines = [`Cross-session search "${query}": ${matches.length} match(es)`];
			for (const m of matches.slice(0, 20)) {
				const ts = m.modified.toISOString().slice(0, 16).replace("T", " ");
				lines.push(`- ${ts}  ${m.id}  ${m.title ?? m.firstMessage.slice(0, 60)}`);
			}
			if (matches.length > 20) lines.push(`… and ${matches.length - 20} more`);
			runtime.ctx.showStatus(lines.join("\n"));
		},
	},
];
