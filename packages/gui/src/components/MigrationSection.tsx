import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { RpcClient } from "../lib/rpc";

/** Settings tab: 数据迁移 (Proma MigrationSettings pattern). The daemon's
 *  agent has file tools, so packing/unpacking runs as a prompted workflow:
 *  copy the archive prompt into any MusePi session on the source machine,
 *  then the restore prompt on the target. Credentials never travel. */
export function MigrationSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [dataDir, setDataDir] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<{ agentDir: string; daemonDir: string }>("migrate.dirs", {})
			.then(d => {
				if (alive) setDataDir(`${d.agentDir}  +  ${d.daemonDir}`);
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

1. 打开数据目录 ${dataDir ?? "（先获取目录）"}
2. 确认范围后整目录打成 zip（例如 musepi-backup.zip）：
   - 会话：daemon 的 journal 目录 + agent 的 sessions 目录（每个会话是 jsonl）
   - 扩展/技能：agent 目录下的 skills、managed-skills、plugins 相关目录
   - 记忆：agent 目录下的 memory 相关文件
   - 配置：agent 目录下的 config.yml 等配置文件（不含密钥）
   - 渠道配置：daemon 目录下的 channels.json
3. 明确排除任何凭据：github-token.json、provider 密钥、keyring 项、cookie 文件
4. 报告压缩包路径和大小；只读操作，不要修改任何原始数据`;

	const restorePrompt = `从迁移压缩包恢复 MusePi 数据：

1. 检查压缩包内容，确认只包含 musepi 数据（journal/sessions/skills/memory/config）
2. 恢复前先为当前数据目录建一个可恢复备份（例如 mv 成 .bak-时间戳）
3. 解压到数据目录（daemon journal 到 daemon 目录，agent 内容到 agent 目录）
4. 按当前版本核对数据结构，逐项确认写入成功
5. 提醒用户重新配置：任何 API Key、GitHub token、渠道密钥（迁移不含凭据）
6. 汇报恢复结果：会话数、技能数、配置项`;

	return (
		<div className="flex flex-col gap-4">
			<p className="text-[13px] text-[var(--color-text-faint)]">
				数据迁移 = 从一台电脑把 MusePi 数据搬到另一台：会话、扩展、记忆、技能、配置。打包/解包由 Agent 完成——在源机器粘贴「创建压缩包」提示词，目标机器粘贴「恢复」提示词。
			</p>

			<div className="rounded-lg border border-[var(--border)] p-3">
				<div className="mb-1 text-[13px] font-semibold">① 源机器：创建压缩包</div>
				<div className="mb-2 flex gap-2">
					<button
						type="button"
						className="gui-btn"
						onClick={() => void copy(archivePrompt, "archive")}
					>
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
					<button
						type="button"
						className="gui-btn"
						onClick={() => void copy(restorePrompt, "restore")}
					>
						{copied === "restore" ? "已复制" : "复制恢复提示词"}
					</button>
				</div>
				<div className="rounded bg-[var(--color-surface-sunken)] p-2 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
					<pre className="whitespace-pre-wrap font-mono text-[11px]">{restorePrompt}</pre>
				</div>
			</div>

			{dataDir && (
				<div className="text-[12px] text-[var(--color-text-faint)]">
					数据目录：<code className="font-mono">{dataDir}</code>
				</div>
			)}

			<div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-amber-200">
				⚠️ 凭据不迁移：API Key、GitHub token、渠道密钥、钥匙串项不会随压缩包移动，
				恢复后需要在目标机器重新配置。
			</div>
		</div>
	);
}
