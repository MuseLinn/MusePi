import { logger } from "@musepi/pi-utils";
import type { ChannelAdapter, ChannelSendPayload, ChannelStatus } from "./types";

/** Huawei today-screen (负一屏) push channel — OpenClaw today-task protocol:
 *  POST the task result to the Huawei HiBoard skill endpoint with the user's
 *  Huawei personal API key/uid in headers. Push-only: no incoming messages.
 *
 *  To enable: on the phone, 负一屏 → 动态管理 → 关联账号 → 开启 Claw 关联
 *  (generates the association code), then configure apiKey/uid here (from
 *  the OpenClaw `.xiaoyienv` PERSONAL-API-KEY / PERSONAL-UID).
 */
export class HuaweiTodayChannel implements ChannelAdapter {
	readonly kind = "huawei-today" as const;
	#config: { apiKey: string; uid: string; authCode?: string; apiUrl?: string } = { apiKey: "", uid: "" };
	#state: ChannelStatus["state"] = "off";
	#detail: string | undefined;

	static readonly DEFAULT_URL = "https://lfhagmirror.hwcloudtest.cn:18449/celia-claw/v1/rest-api/skill/execute";

	async configure(config: Record<string, unknown>): Promise<void> {
		this.#config = {
			apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
			uid: typeof config.uid === "string" ? config.uid : "",
			authCode: typeof config.authCode === "string" ? config.authCode : undefined,
			apiUrl: typeof config.apiUrl === "string" && config.apiUrl ? config.apiUrl : undefined,
		};
	}

	async start(): Promise<void> {
		if (!this.#config.apiKey || !this.#config.uid) {
			this.#state = "error";
			this.#detail = "missing apiKey/uid — configure the channel first";
			throw new Error(this.#detail);
		}
		this.#state = "connected";
		this.#detail = "ready — task results push to the today screen";
	}

	async stop(): Promise<void> {
		this.#state = "off";
		this.#detail = undefined;
	}

	status(): ChannelStatus {
		return {
			kind: this.kind,
			state: this.#state,
			detail: this.#detail,
			config: {
				apiKey: this.#config.apiKey ? `••••${this.#config.apiKey.slice(-4)}` : "",
				uid: this.#config.uid,
				authCode: this.#config.authCode ? `••••${this.#config.authCode.slice(-4)}` : "",
				apiUrl: this.#config.apiUrl ?? HuaweiTodayChannel.DEFAULT_URL,
			},
		};
	}

	async send(payload: ChannelSendPayload): Promise<void> {
		if (this.#state !== "connected") throw new Error("huawei-today channel not connected");
		const url = this.#config.apiUrl ?? HuaweiTodayChannel.DEFAULT_URL;
		const traceId = `task-push-${Date.now()}`;
		const body = {
			task_name: payload.taskName ?? "MusePi task",
			task_content: payload.markdown ?? payload.text,
			task_result: payload.taskResult ?? "completed",
			userId: this.#config.uid,
			appPackage: "com.huawei.hag",
		};
		const headers = {
			"Content-Type": "application/json",
			Accept: "application/json",
			"x-hag-trace-id": traceId,
			"x-api-key": this.#config.apiKey,
			"x-request-from": "musepi",
			"x-uid": this.#config.uid,
			"x-skill-id": "hiboard_today_task",
			"x-prd-pkg-name": "com.huawei.hag",
			"x-trace-id": traceId,
		};
		logger.info(`huawei-today push → ${url}`, { task: body.task_name, traceId });
		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`huawei-today push failed: ${res.status} ${text.slice(0, 200)}`);
		}
	}
}
