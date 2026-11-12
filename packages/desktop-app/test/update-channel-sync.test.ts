import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import type { RpcClient } from "../src/lib/rpc";
import { dispatchSettingsChanged } from "../src/lib/settings-events";
import { syncUpdateChannel } from "../src/lib/update-channel";

/**
 * The desktop updater cannot read daemon settings, so the shell mirrors
 * `update.channel` into it. A mirror that only pushes once would leave a
 * channel switch invisible until the next launch; one that never unsubscribes
 * would keep pushing after the session is replaced. The shell bridge is
 * injected: happy-dom's `window` is shared by every file in a worker, so a
 * test must not install a global `electronAPI` to observe this.
 */

function fakeRpc(initial: string): { rpc: RpcClient; set: (channel: string) => void } {
	let channel = initial;
	const rpc = {
		request: async () => ({ "update.channel": channel }),
	} as unknown as RpcClient;
	return { rpc, set: next => (channel = next) };
}

describe("update channel mirror", () => {
	it("pushes the stored channel on start and again after a commit", async () => {
		const pushed: string[] = [];
		const { rpc, set } = fakeRpc("beta");

		const stop = syncUpdateChannel(rpc, channel => pushed.push(channel));
		await Bun.sleep(0);
		expect(pushed).toEqual(["beta"]);

		set("stable");
		dispatchSettingsChanged("update.channel");
		await Bun.sleep(0);
		expect(pushed).toEqual(["beta", "stable"]);

		stop();
	});

	it("stops pushing once unsubscribed", async () => {
		const pushed: string[] = [];
		const { rpc } = fakeRpc("stable");

		syncUpdateChannel(rpc, channel => pushed.push(channel))();
		await Bun.sleep(0);
		const before = pushed.length;
		dispatchSettingsChanged("update.channel");
		await Bun.sleep(0);
		expect(pushed.length).toBe(before);
	});
});
