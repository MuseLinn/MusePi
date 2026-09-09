import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../lib/rpc";

/** Settings tab: 数据迁移 (Proma MigrationSettings pattern). The daemon's
 *  agent has file tools, so packing/unpacking runs as a prompted workflow:
 *  copy the archive prompt into any MusePi session on the source machine,
 *  then the restore prompt on the target.
 *
 *  Data layout (dirs.ts / daemon server.ts facts):
 *  - agentDir (~/.musepi/agent): durable user data — sessions(+archive)/,
 *    skills/, managed-skills/, memory/, config.yml, prompts/, extensions/,
 *    agent.db (settings + auth credentials + memory DB), github-token.json.
 *  - daemonDir: RUNTIME-ONLY temp dir (os.tmpdir()/musepi-daemon) — socket,
 *    journal/, materialized.db, channels.json. Ephemeral; never a backup
 *    source except channels.json, which lives there too by design. */
export function MigrationSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [dirs, setDirs] = useState<{ agentDir: string; daemonDir: string } | null>(null);
	const [copied, setCopied] = useState<string | null>(null);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<{ agentDir: string; daemonDir: string }>("migrate.dirs", {})
			.then(d => {
				if (alive) setDirs({ agentDir: d.agentDir, daemonDir: d.daemonDir });
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc]);

	const copy = async (text: string, key: string): Promise<void> => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(key);
			setTimeout(() => setCopied(null), 1500);
		} catch {
			// clipboard unavailable
		}
	};

	const archivePrompt = `把 MusePi 数据打包成迁移压缩包，用于在新电脑恢复：

1. 打开数据目录 ${dirs?.agentDir ?? "（先获取目录）"}
2. 确认范围后打成 zip（例如 musepi-backup.zip）：
   - 会话：agent 目录下的 sessions/ 与 archive/sessions/（每个会话是 jsonl）
   - 扩展/技能：agent 目录下的 skills、managed-skills、plugins 相关目录
   - 记忆：agent 目录下的 memory 相关文件
   - 配置：agent 目录下的 config.yml 等配置文件
   - 渠道配置：daemon 运行时目录（临时目录）下的 channels.json
3. 凭据处理：github-token.json 不要打进压缩包；注意 API Key/OAuth 登录凭据
   保存在 agent.db 内部，无法在打包层剥离——如实告知用户压缩包含凭据，
   提醒妥善保管，恢复后在目标机器检查并按需重新登录
4. 报告压缩包路径和大小；只读操作，不要修改任何原始数据`;

	const restorePrompt = `从迁移压缩包恢复 MusePi 数据：

1. 检查压缩包内容，确认只包含 musepi 数据（sessions/skills/memory/config/channels.json）
2. 恢复前先为当前数据目录建一个可恢复备份（例如 mv 成 .bak-时间戳）
3. 解压到数据目录：会话/技能/记忆/配置写入 agent 目录；channels.json 写入
   daemon 运行时目录（该目录是临时目录，daemon 重启可能重建）
4. 按当前版本核对数据结构，逐项确认写入成功
5. 提醒用户重新配置：GitHub token 已被排除；agent.db 内的 API Key/OAuth
   凭据与渠道密钥建议在目标机器重新登录或更新
6. 汇报恢复结果：会话数、技能数、配置项`;

	return (
		<div className="flex flex-col gap-4">
			<p className="text-[13px] text-[var(--color-text-faint)]">
				数据迁移 = 从一台电脑把 MusePi 数据搬到另一台：会话、扩展、记忆、技能、配置。打包/解包由 Agent
				完成——在源机器粘贴「创建压缩包」提示词，目标机器粘贴「恢复」提示词。
			</p>

			<div className="rounded-lg border border-[var(--border)] p-3">
				<div className="mb-1 text-[13px] font-semibold">① 源机器：创建压缩包</div>
				<div className="mb-2 flex gap-2">
					<button type="button" className="gui-btn" onClick={() => void copy(archivePrompt, "archive")}>
						{copied === "archive" ? "已复制" : "复制创建压缩包提示词"}
					</button>
				</div>
				<div className="rounded bg-[var(--color-surface-sunken)] p-2 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
					<pre className="whitespace-pre-wrap font-mono text-[11px]">{archivePrompt}</pre>
				</div>
			</div>

			<div className="rounded-lg border border-[var(--border)] p-3">
				<div className="mb-1 text-[13px] font-semibold">② 目标机器：恢复</div>
				<div className="mb-2 flex gap-2">
					<button type="button" className="gui-btn" onClick={() => void copy(restorePrompt, "restore")}>
						{copied === "restore" ? "已复制" : "复制恢复提示词"}
					</button>
				</div>
				<div className="rounded bg-[var(--color-surface-sunken)] p-2 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
					<pre className="whitespace-pre-wrap font-mono text-[11px]">{restorePrompt}</pre>
				</div>
			</div>

			{dirs && (
				<div className="flex flex-col gap-1 text-[12px] text-[var(--color-text-faint)]">
					<div>
						数据目录：<code className="font-mono">{dirs.agentDir}</code>
					</div>
					<div>
						运行时目录：
						<code className="font-mono">{dirs.daemonDir}</code>
						（临时目录，不随备份迁移）
					</div>
				</div>
			)}

			<div className="gui-settings-warn-note">
				<span className="gui-settings-warn-note-icon" aria-hidden="true">
					⚠️
				</span>
				<span>
					<strong>凭据随包携带：</strong>
					API Key / OAuth 登录凭据保存在 agent.db、渠道密钥在 channels.json——它们会随数据目录进入压缩包， GitHub
					token（github-token.json）已被提示词排除。压缩包请妥善保管，恢复后在目标机器检查并按需重新登录。
				</span>
			</div>
		</div>
	);
}
