import { describe, expect, test } from "bun:test";
import { ExpectedDisconnects, RpcClient } from "../src/lib/rpc";

describe("ExpectedDisconnects", () => {
	test("consumes only the intentional close of the replaced client", () => {
		const disconnects = new ExpectedDisconnects();
		const replaced = new RpcClient("ws://127.0.0.1:8300");
		const unexpected = new RpcClient("ws://127.0.0.1:8300");

		expect(disconnects.consume(replaced)).toBe(false);
		disconnects.expect(replaced);
		expect(disconnects.consume(replaced)).toBe(true);
		expect(disconnects.consume(replaced)).toBe(false);
		expect(disconnects.consume(unexpected)).toBe(false);
	});
});
