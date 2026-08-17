import { t } from "@musepi/desktop-web";
import type { AgentSnapshot } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useState } from "react";
import type { RpcClient } from "../lib/rpc";

/**
 * Desktop subagent operations (TUI Agent Hub parity: r=revive, x=kill,
 * chat=revive+steer). Rendered under the selected row in the right-rail
 * AgentsPanel; talks to the daemon's agents.kill/revive/chat RPCs (the
 * collab guest path uses agent-cmd frames instead — desktop has no guest
 * host, so these are RPC-only).
 */
export function AgentControls({
	agent,
	rpc,
	onClose,
	onChanged,
}: {
	agent: AgentSnapshot;
	rpc: RpcClient | null;
	onClose(): void;
	/** Fired after a mutating op lands so the caller can refresh its roster. */
	onChanged?(): void;
}): ReactNode {
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState<"kill" | "revive" | "chat" | null>(null);
	const [error, setError] = useState<string | null>(null);

	const run = async (op: "kill" | "revive" | "chat", text?: string): Promise<void> => {
		if (!rpc || busy) return;
		setBusy(op);
		setError(null);
		try {
			const res = (await rpc.request(`agents.${op}`, {
				agentId: agent.id,
				...(text !== undefined ? { text } : {}),
			})) as {
				ok?: boolean;
				error?: string;
			};
			if (res?.ok === false) setError(res.error ?? t("operation failed"));
			else onChanged?.();
			if (op === "chat") setDraft("");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const actionable =
		agent.status === "running" || agent.status === "parked" || agent.status === "aborted" || agent.status === "idle";

	return (
		<div className="gui-agent-controls">
			<div className="gui-agent-controls-head">
				<span className="truncate text-[12px] font-medium">{agent.displayName}</span>
				<span className={`gui-agent-status gui-agent-status--${agent.status}`}>{agent.status}</span>
				<button
					type="button"
					className="gui-agent-controls-close"
					aria-label={t("close")}
					title={t("close")}
					onClick={onClose}
				>
					×
				</button>
			</div>
			{actionable && (
				<div className="gui-agent-controls-row">
					{agent.status === "running" && (
						<button
							type="button"
							className="gui-agent-controls-btn gui-agent-controls-btn--danger"
							disabled={busy !== null}
							onClick={() => void run("kill")}
						>
							{busy === "kill" ? "…" : t("kill")}
						</button>
					)}
					{(agent.status === "parked" || agent.status === "aborted") && (
						<button
							type="button"
							className="gui-agent-controls-btn"
							disabled={busy !== null}
							onClick={() => void run("revive")}
						>
							{busy === "revive" ? "…" : t("revive")}
						</button>
					)}
				</div>
			)}
			<form
				className="gui-agent-controls-chat"
				onSubmit={e => {
					e.preventDefault();
					void run("chat", draft);
				}}
			>
				<input
					className="gui-agent-controls-input"
					value={draft}
					placeholder={t("message {name}…", { name: agent.displayName })}
					disabled={busy !== null}
					onChange={e => setDraft(e.target.value)}
				/>
				<button
					type="submit"
					className="gui-agent-controls-send"
					aria-label={t("send")}
					title={t("send")}
					disabled={busy !== null || draft.trim().length === 0}
				>
					{busy === "chat" ? "…" : "↵"}
				</button>
			</form>
			{error && <div className="gui-agent-controls-error">{error}</div>}
		</div>
	);
}
