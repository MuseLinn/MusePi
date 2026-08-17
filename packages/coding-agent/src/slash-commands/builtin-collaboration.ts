import { Spacer } from "@musepi/pi-tui";
import { APP_NAME } from "@musepi/pi-utils";
import { CollabGuestLink } from "../collab/guest";
import { findLanIpv4, isTailscaleIpv4, type LanShareUrls, LocalShareManager } from "../collab/local-share";
import { formatCollabWebLink, parseCollabLink } from "@musepi/collab-proto";
import { t } from "../i18n/index.js";
import { CollabHost } from "../collab/host";
import type { SettingPath, SettingValue } from "../config/settings";
import { settings } from "../config/settings";
import { parseExportArgs } from "../export/html/args";
import { shareSession } from "../export/share";
import { theme } from "../modes/theme/theme";
import type { InteractiveModeContext } from "../modes/types";
import { extractLastCodeBlock, extractLastCommand } from "../modes/utils/copy-targets";
import { urlHyperlinkAlways } from "../tui";
import { copyToClipboard } from "../utils/clipboard";
import { refreshStatusLine } from "./builtin-modes";
import { CollabQrCodeComponent } from "./helpers/collab-qrcode";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

/** Scheme-less display form of a browser deep link: accent + underline, OSC-8 linked to the full URL. */
function collabWebLinkClickable(webLink: string): string {
	const display = theme.fg("accent", `\x1b[4m${webLink.replace(/^https?:\/\//, "")}\x1b[24m`);
	return urlHyperlinkAlways(webLink, display);
}

/** Join hint printed by /collab: compact terminal link + clickable browser deep link. */
async function stopCollabSharing(ctx: InteractiveModeContext): Promise<void> {
	await ctx.collabHost?.stop("host stopped");
	ctx.collabHost = undefined;
	if (ctx.collabTransport) {
		await ctx.collabTransport.stop();
		ctx.collabTransport = undefined;
	}
}


interface AltLinkInfo {
	label: string;
	webLink: string;
}


function isSelfSignedWebLink(webLink: string): boolean {
	const url = new URL(webLink);
	return url.protocol === "https:" && !url.hostname.endsWith(".ts.net");
}


function collabLinkHint(
	host: CollabHost,
	heading: string,
	view = false,
	alt: AltLinkInfo[] = [],
	certHint?: string,
): string {
	const bullet = theme.fg("accent", theme.format.bullet);
	const link = view ? host.viewLink : host.link;
	const webLink = view ? host.webViewLink : host.webLink;
	const rows = [
		theme.fg("success", heading),
		` ${bullet} ${theme.fg("muted", view ? t("Watch from another terminal:") : t("Join from another terminal:"))} ${APP_NAME} join "${link}"`,
		` ${bullet} ${theme.fg("muted", t("or any web browser:"))} ${collabWebLinkClickable(webLink)}`,
	];
	for (const a of alt) {
		rows.push(` ${bullet} ${theme.fg("muted", a.label)}: ${collabWebLinkClickable(a.webLink)}`);
	}
	if (certHint) {
		rows.push(theme.fg("dim", certHint));
	}
	rows.push(
		theme.fg(
			"dim",
			view
				? t("Anyone with this link can watch the session but cannot prompt the agent.")
				: t("Anyone with the link can read the session and prompt the agent. Read-only link: /collab view"),
		),
	);
	return rows.join("\n");
}


function showCollabQrCode(ctx: InteractiveModeContext, webLink: string): void {
	try {
		ctx.present([new Spacer(1), new CollabQrCodeComponent(webLink)]);
	} catch (err) {
		ctx.showError(t("Failed to render collab QR code: {0}", errorMessage(err)));
	}
}


function showCollabLink(
	ctx: InteractiveModeContext,
	host: CollabHost,
	heading: string,
	view = false,
	alt: AltLinkInfo[] = [],
	qrWebLink?: string,
	certHint?: string,
): void {
	ctx.showStatus(collabLinkHint(host, heading, view, alt, certHint), { dim: false });
	showCollabQrCode(ctx, qrWebLink ?? (view ? host.webViewLink : host.webLink));
}


/**
 * Render a "<Prefix>: <state>" autocomplete status line, translating both
 * parts at render time (the locale is applied after this module loads and can
 * change at runtime). Pass already-translated or dynamic text as `state`.
 */
const statusLine = (prefix: string, state: string): string => `${t(prefix)}: ${state}`;

export const BUILTIN_COLLABORATION_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "advisor",
		description: "Toggle the advisor (a second model that reviews each turn and injects notes)",
		acpDescription: "Toggle advisor",
		acpInputHint: "[on|off|status|dump [raw]|configure]",
		subcommands: [
			{ name: "on", description: "Enable the advisor" },
			{ name: "off", description: "Disable the advisor" },
			{ name: "status", description: "Show advisor status" },
			{ name: "dump", description: "Copy the advisor's transcript to clipboard", usage: "[raw]" },
			{ name: "configure", description: "Open the advisor configuration editor (TUI)" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const stats = runtime.ctx.session.getAdvisorStats();
			if (stats.active && stats.advisors.length > 1)
				return statusLine("Advisor", `${t("on")} (${stats.advisors.length} ${t("advisors")})`);
			if (stats.active && stats.model)
				return statusLine("Advisor", `${t("on")} (${stats.model.provider}/${stats.model.id})`);
			if (stats.configured) return statusLine("Advisor", t("configured, no model"));
			return statusLine("Advisor", t("off"));
		},
		
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.session.toggleAdvisorEnabled();
				const configured = runtime.session.isAdvisorEnabled();
				if (active) {
					await runtime.output("Advisor enabled.");
				} else if (configured) {
					await runtime.output("Advisor setting enabled, but no model is assigned to the 'advisor' role.");
				} else {
					await runtime.output("Advisor disabled.");
				}
				return commandConsumed();
			}
			if (verb === "on") {
				const active = runtime.session.setAdvisorEnabled(true);
				await runtime.output(
					active ? "Advisor enabled." : "Advisor setting enabled, but no model is assigned to the 'advisor' role.",
				);
				return commandConsumed();
			}
			if (verb === "off") {
				runtime.session.setAdvisorEnabled(false);
				await runtime.output("Advisor disabled.");
				return commandConsumed();
			}
			if (verb === "status") {
				await runtime.output(runtime.session.formatAdvisorStatus());
				return commandConsumed();
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				const text = runtime.session.formatAdvisorHistoryAsText({ compact: !isRaw });
				await runtime.output(text ?? "Advisor is not active for this session.");
				return commandConsumed();
			}
			if (verb === "configure") {
				await runtime.output(
					"/advisor configure opens an interactive editor and is only available in the interactive TUI.",
				);
				return commandConsumed();
			}
			return usage("Usage: /advisor [on|off|status|dump [raw]|configure]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.ctx.session.toggleAdvisorEnabled();
				const configured = runtime.ctx.session.isAdvisorEnabled();
				if (active) {
					runtime.ctx.showStatus("Advisor enabled.");
				} else if (configured) {
					runtime.ctx.showStatus("Advisor setting enabled, but no model is assigned to the 'advisor' role.");
				} else {
					runtime.ctx.showStatus("Advisor disabled.");
				}
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "on") {
				const active = runtime.ctx.session.setAdvisorEnabled(true);
				runtime.ctx.showStatus(
					active ? "Advisor enabled." : "Advisor setting enabled, but no model is assigned to the 'advisor' role.",
				);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "off") {
				runtime.ctx.session.setAdvisorEnabled(false);
				runtime.ctx.showStatus("Advisor disabled.");
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "status") {
				await runtime.ctx.handleAdvisorStatusCommand();
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				runtime.ctx.handleAdvisorDumpCommand(isRaw);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "configure") {
				runtime.ctx.showAdvisorConfigure();
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /advisor [on|off|status|dump [raw]|configure]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "export",
		description: "Export session to HTML file",
		inlineHint: "[--themes] [path]",
		allowArgs: true,
		handle: async (command, runtime) => {
			try {
				const { outputPath, useUserThemes } = parseExportArgs(command.args);
				if (outputPath === "--copy" || outputPath === "clipboard" || outputPath === "copy") {
					return usage("Use /dump to copy the session to clipboard.", runtime);
				}
				const filePath = await runtime.session.exportToHtml(outputPath, useUserThemes);
				await runtime.output(`Session exported to: ${filePath}`);
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to export session: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "dump",
		description: "Copy session transcript to clipboard (and write LLM request JSON to tmp)",
		acpDescription: "Return full transcript as plain text, with LLM request JSON path",
		allowArgs: true,
		handle: async (_command, runtime) => {
			const text = runtime.session.formatSessionAsText();
			if (!text) {
				await runtime.output("No messages to dump yet.");
				return commandConsumed();
			}
			let sidecarPath: string | undefined;
			try {
				sidecarPath = await runtime.session.dumpLlmRequestToTmpDir();
			} catch {
				// Sidecar is best-effort; the transcript is still output below.
			}
			const lines = [text];
			if (sidecarPath)
				lines.push(
					"",
					`LLM request JSON: ${sidecarPath}`,
					"This file persists on disk and may contain raw context/secrets — treat accordingly.",
				);
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleDumpCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "share",
		description: "Share session via an encrypted link (share server or secret gist)",
		handle: async (_command, runtime) => {
			try {
				const result = await shareSession(runtime.sessionManager, {
					serverUrl: runtime.settings.get("share.serverUrl"),
					store: runtime.settings.get("share.store"),
					state: runtime.session.state,
					obfuscator: runtime.settings.get("share.redactSecrets") ? runtime.session.obfuscator : undefined,
				});
				const lines = [`Share URL: ${result.url}`];
				if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
				if (result.truncated) lines.push("Note: large content was trimmed to fit the share size limit.");
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to share session: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleShareCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "collab",
		description: "Share this session live via a relay",
		inlineHint: "[workspace|lan|tunnel [ngrok|cloudflared]|start|view|stop|status] [relayUrl]",
		subcommands: [
			{ name: "view", description: "Share a read-only link (guests can watch, not prompt)" },
			{ name: "workspace", description: "Share the multi-session workspace (guests pick a session to watch)" },
			{ name: "lan", description: "Share on the local network (self-hosted relay)" },
			{ name: "tunnel", description: "Share via a public cloudflared tunnel" },
			{ name: "status", description: "Show link + participants" },
			{ name: "stop", description: "Stop sharing" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabHost) {
				return statusLine(
					"Collab",
					`${t("hosting")} (${Math.max(0, runtime.ctx.collabHost.participants.length - 1)} ${t("guests")})`,
				);
			}
			if (runtime.ctx.collabGuest?.readOnly) return statusLine("Collab", t("read-only guest"));
			if (runtime.ctx.collabGuest) return statusLine("Collab", t("guest"));
			return statusLine("Collab", t("off"));
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const args = command.args.trim();
			const { verb, rest } = parseSubcommand(args);
			if (verb === "stop") {
				if (!ctx.collabHost) {
					ctx.showStatus(t("Not hosting a collab session"));
					return;
				}
				await stopCollabSharing(ctx);
				ctx.showStatus(t("Collab stopped"));
				return;
			}
			if (verb === "status") {
				if (ctx.collabHost) {
					const names = ctx.collabHost.participants.map(p =>
						p.role === "host" ? `${p.name} (host)` : p.readOnly ? `${p.name} (view-only)` : p.name,
					);
					ctx.showStatus(t("Collab: {0} — {1}", names.join(", "), collabWebLinkClickable(ctx.collabHost.webLink)));
				} else if (ctx.collabGuest) {
					ctx.showStatus(
						ctx.collabGuest.readOnly
							? t("In a collab session as a read-only guest (/leave to exit)")
							: t("In a collab session as a guest (/leave to exit)"),
					);
				} else {
					ctx.showStatus(t("Not in a collab session"));
				}
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError(t("Already in a collab session as a guest (/leave first)"));
				return;
			}
			if (verb === "workspace") {
				// Multi-session workspace share: guests land on a directory of
				// every known session and pick one to watch live. The TUI host
				// can only stream its own session; others list as history.
				const [arg0] = rest.trim().split(/\s+/);
				const isTunnel = arg0 === "tunnel";
				const transport = new LocalShareManager({
					onStatus: line => ctx.showStatus(line, { dim: true }),
				});
				const { listAllSessions } = await import("../session/session-listing");
				const currentId = ctx.sessionManager.getSessionId();
				const workspaceProvider = {
					listWorkspaceSessions: async () => {
						const all = await listAllSessions();
						const rows = all.map(s => ({
							id: s.id,
							title:
								(s.firstMessage && s.firstMessage !== "(no messages)" ? s.firstMessage : null)?.slice(0, 80) ??
								null,
							cwd: s.cwd ?? null,
							messageCount: s.messageCount,
							working: s.id === currentId ? ctx.session.isStreaming : false,
							paused: false,
							live: s.id === currentId,
							updatedAt: s.modified.getTime(),
						}));
						// The live session always leads the directory.
						return rows.sort((a, b) => (a.id === currentId ? -1 : b.id === currentId ? 1 : b.updatedAt - a.updatedAt));
					},
					subscribeWorkspace: (cb: () => void) =>
						ctx.session.subscribe(event => {
							if (event.type === "agent_start" || event.type === "agent_end") cb();
						}),
					switchWorkspaceSession: async (sessionId: string) => sessionId === currentId,
				};
				ctx.workspace = workspaceProvider;
				const host = new CollabHost(ctx, "workspace");
				let urls: LanShareUrls;
				try {
					urls = isTunnel ? await transport.startTunnel("cloudflared") : await transport.startLan();
					await host.start(urls.joinUrl, urls.webUrl, urls.webJoinUrl);
				} catch (err) {
					await transport.stop().catch(() => {});
					ctx.workspace = undefined;
					ctx.showError(
						isTunnel
							? t("Failed to start tunnel workspace: {0}", errorMessage(err))
							: t("Failed to start LAN workspace: {0}", errorMessage(err)),
					);
					return;
				}
				ctx.collabHost = host;
				ctx.collabTransport = transport;
				ctx.showStatus(t("Workspace collab started — guests can browse all sessions"));
				return;
			}
			if (verb === "lan" || verb === "tunnel") {
				const isTunnel = verb === "tunnel";
				// `/collab tunnel [ngrok|cloudflared] [port]` — provider mirrors
				// OpenChamber's cloudflared-vs-ngrok choice; default cloudflared.
				const [arg0, arg1] = rest.trim().split(/\s+/);
				const providerArg = isTunnel && (arg0 === "ngrok" || arg0 === "cloudflared") ? arg0 : undefined;
				const provider = providerArg ?? "cloudflared";
				const portArg = providerArg ? arg1 : arg0;
				const port = parseInt(portArg ?? "", 10) || undefined;
				const transport = new LocalShareManager({
					port,
					onStatus: line => ctx.showStatus(line, { dim: true }),
				});
				const host = new CollabHost(ctx);
				let urls: LanShareUrls;
				try {
					urls = isTunnel ? await transport.startTunnel(provider) : await transport.startLan();
					await host.start(urls.joinUrl, urls.webUrl, urls.webJoinUrl);
				} catch (err) {
					await transport.stop().catch(() => {});
					const message = errorMessage(err);
					// EADDRINUSE from a previous share that never got torn down, or a
					// missing cloudflared binary (both common setup mistakes).
					const hint = /Failed to listen/i.test(message)
						? t(" (port already in use — stop a previous collab session first)")
						: /is not installed/i.test(message)
							? t(" (cloudflared is not installed — see the error above for install instructions)")
							: "";
					ctx.showError(
						isTunnel
							? t("Failed to start tunnel collab: {0}", message + hint)
							: t("Failed to start LAN collab: {0}", message + hint),
					);
					return;
				}
				ctx.collabHost = host;
				ctx.collabTransport = transport;
				let alt: AltLinkInfo[] = [];
				let qrWebLink: string | undefined;
				let certHint: string | undefined;
				if (!isTunnel) {
					// Other devices need the https link (insecure http cannot run
					// WebCrypto); the host machine itself joins over plaintext
					// localhost instead. Extra NICs (Tailscale 100.64/10, second
					// adapter) each get their own reachable link set.
					const lanIp = findLanIpv4();
					if (lanIp && transport.relay) {
						const local = `http://localhost:${transport.relay.port}/#${host.link.split(lanIp).join("localhost")}`;
						ctx.showStatus(`${t("On this machine, open:")} ${collabWebLinkClickable(local)}`, { dim: true });
						const webLink = host.webLink;
						// A tailnet serve URL carries a real Let's Encrypt cert — no
						// browser warning — and supersedes the raw Tailscale IP link.
						let serveWebLink: string | undefined;
						if (urls.tailnetServeUrl) {
							const parsed = parseCollabLink(host.link);
							if (!("error" in parsed)) {
								const serveHost = new URL(urls.tailnetServeUrl).hostname;
								serveWebLink = formatCollabWebLink(
									`wss://${serveHost}`,
									parsed.roomId,
									parsed.key,
									parsed.writeToken,
									urls.tailnetServeUrl,
								);
							}
						}
						alt = (urls.alt ?? [])
							.filter(u => u.joinUrl !== urls.joinUrl)
							.map(u => {
								const ip = new URL(u.joinUrl).hostname;
								// The browser deep link is what matters for a phone;
								// the terminal join link is derivable from it. The raw
								// Tailscale IP stays listed even when serve is up: the
								// MagicDNS name is unresolvable on hosts whose manual DNS
								// shadows Tailscale's split-DNS, so the 100.x direct link
								// is the reliable fallback.
								return {
									label: isTailscaleIpv4(ip) ? t("Tailscale IP") : ip,
									webLink: webLink.split(lanIp).join(ip),
								};
							});
						if (serveWebLink) {
							alt.unshift({ label: t("Tailscale (no cert warning)"), webLink: serveWebLink });
						}
						// No-encryption fallback for browsers that refuse the self-signed
						// cert: plain http is a non-secure context (no crypto.subtle) so
						// the guest degrades to plaintext frames — zero warning, zero E2E.
						if (transport.relay) {
							alt.push({
								label: t("Plaintext http (no encryption)"),
								webLink: `http://${lanIp}:${transport.relay.port}/#${host.link}`,
							});
						}
						// QR is scanned by phones: prefer the zero-warning serve link,
						// else the Tailscale IP, else the LAN link.
						qrWebLink =
							serveWebLink ?? alt.find(a => isTailscaleIpv4(new URL(a.webLink).hostname))?.webLink ?? webLink;
						// Raw-LAN / Tailscale-IP https links carry the self-signed cert;
						// warn up front because the browser's certificate interstitial
						// appears before any in-page guidance can load. (Serve links end
						// in .ts.net and carry a real Let's Encrypt cert — excluded.)
						certHint = [webLink, ...alt.map(a => a.webLink)].some(isSelfSignedWebLink)
							? t("First visit shows a self-signed certificate warning — click Advanced → Continue")
							: undefined;
					}
				}
				showCollabLink(
					ctx,
					host,
					isTunnel ? t("Collab session started (tunnel)!") : t("Collab session started (LAN)!"),
					false,
					alt,
					qrWebLink,
					certHint,
				);
				return;
			}
			const knownStartVerb = verb === "start" || verb === "view";
			const view = verb === "view";
			if (ctx.collabHost) {
				showCollabLink(
					ctx,
					ctx.collabHost,
					view ? t("Read-only collab session active") : t("Collab session active"),
					view,
				);
				return;
			}
			const explicitUrl = knownStartVerb ? rest : args;
			const relayInput = explicitUrl || ctx.settings.get("collab.relayUrl") || "";
			if (!relayInput) {
				ctx.showError(
					t("No relay configured. Set collab.relayUrl in /settings or pass one: /collab relay.example.com"),
				);
				return;
			}
			// Scheme-less relay args default to wss (ws:// must be spelled out for localhost).
			const relayUrl = relayInput.includes("://") ? relayInput : `wss://${relayInput}`;
			const webUrl = ctx.settings.get("collab.webUrl") || "";
			const host = new CollabHost(ctx);
			try {
				await host.start(relayUrl, webUrl);
			} catch (err) {
				ctx.showError(t("Failed to start collab session: {0}", errorMessage(err)));
				return;
			}
			ctx.collabHost = host;
			showCollabLink(ctx, host, t("Collab session started!"), view);
		},
	},
	{
		name: "join",
		description: "Join a shared collab session",
		inlineHint: "<link>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const link = command.args.trim();
			if (!link) {
				ctx.showError("Usage: /join <link>");
				return;
			}
			if (ctx.collabHost) {
				ctx.showError("Stop hosting first (/collab stop)");
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError("Already in a collab session (/leave first)");
				return;
			}
			try {
				await new CollabGuestLink(ctx).join(link);
			} catch (err) {
				ctx.showError(`Failed to join collab session: ${errorMessage(err)}`);
			}
		},
	},
	{
		name: "leave",
		description: "Leave the collab session",
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabHost) return statusLine("Leave collab", t("hosting"));
			if (runtime.ctx.collabGuest) return statusLine("Leave collab", t("guest"));
			return statusLine("Leave collab", t("not in collab"));
		},
		handleTui: async (_command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			if (ctx.collabGuest) {
				await ctx.collabGuest.leave("left");
				return;
			}
			if (ctx.collabHost) {
				// Host leaving = stop sharing entirely: leaving the relay up would
				// leak the LAN ports and break the next /collab lan.
				await stopCollabSharing(ctx);
				ctx.showStatus(t("Collab stopped"));
				return;
			}
			ctx.showStatus(t("Not in a collab session"));
		},
	},
	{
		name: "browser",
		description: "Toggle browser headless vs visible mode",
		acpInputHint: "[headless|visible]",
		subcommands: [
			{ name: "headless", description: "Switch to headless mode" },
			{ name: "visible", description: "Switch to visible mode" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("browser.enabled" as SettingPath)) return statusLine("Browser", t("disabled"));
			return runtime.ctx.settings.get("browser.headless" as SettingPath)
				? statusLine("Browser", t("headless"))
				: statusLine("Browser", t("visible"));
		},
		
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const enabled = runtime.settings.get("browser.enabled" as SettingPath) as boolean;
			if (!enabled) return usage("Browser tool is disabled (enable in settings).", runtime);
			const current = runtime.settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!arg) next = !current;
			else if (arg === "headless" || arg === "hidden") next = true;
			else if (arg === "visible" || arg === "show" || arg === "headful") next = false;
			else return usage("Usage: /browser [headless|visible]", runtime);
			runtime.settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (err) {
					// Setting was already mutated; surface the restart failure so the
					// user knows the browser is in an inconsistent state.
					await runtime.output(
						`Browser mode set to ${next ? "headless" : "visible"}, but restart failed: ${errorMessage(err)}`,
					);
					return commandConsumed();
				}
			}
			await runtime.output(`Browser mode: ${next ? "headless" : "visible"}`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const current = settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!(settings.get("browser.enabled" as SettingPath) as boolean)) {
				runtime.ctx.showWarning("Browser tool is disabled (enable in settings)");
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg) {
				next = !current;
			} else if (arg === "headless" || arg === "hidden") {
				next = true;
			} else if (arg === "visible" || arg === "show" || arg === "headful") {
				next = false;
			} else {
				runtime.ctx.showStatus("Usage: /browser [headless|visible]");
				runtime.ctx.editor.setText("");
				return;
			}
			settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.ctx.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (error) {
					runtime.ctx.showWarning(`Failed to restart browser: ${errorMessage(error)}`);
					runtime.ctx.editor.setText("");
					return;
				}
			}
			runtime.ctx.showStatus(`Browser mode: ${next ? "headless" : "visible"}`);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "copy",
		description: "Pick text or code from the conversation to copy",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg) {
				runtime.ctx.showCopySelector();
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "code") {
				const block = extractLastCodeBlock(runtime.ctx.session.messages);
				if (!block) {
					runtime.ctx.showStatus("No code block to copy.");
					runtime.ctx.editor.setText("");
					return;
				}
				await copyToClipboard(block.code);
				runtime.ctx.showStatus("Copied code block to clipboard");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "cmd" || arg === "command") {
				const lastCommand = extractLastCommand(runtime.ctx.session.messages);
				if (!lastCommand) {
					runtime.ctx.showStatus("No command to copy.");
					runtime.ctx.editor.setText("");
					return;
				}
				await copyToClipboard(lastCommand.code);
				runtime.ctx.showStatus(`Copied ${lastCommand.kind === "bash" ? "bash command" : "eval code"} to clipboard`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /copy [code|cmd]");
			runtime.ctx.editor.setText("");
		},
	},
];
