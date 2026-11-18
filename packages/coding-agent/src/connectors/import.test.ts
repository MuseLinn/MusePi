import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { importConnectorId } from "./import";

describe("import connector ids", () => {
	it("slugifies a name and keeps it valid", () => {
		expect(importConnectorId("My Server", [])).toBe("my-server");
		expect(importConnectorId("  Weird__Name!! ", [])).toBe("weird-name");
		expect(importConnectorId("123", [])).toBe("c-123");
	});

	it("avoids a name already taken", () => {
		expect(importConnectorId("server", ["server"])).toBe("server-2");
		expect(importConnectorId("server", ["server", "server-2"])).toBe("server-3");
	});

	it("falls back when a name has nothing usable", () => {
		expect(importConnectorId("!!!", [])).toBe("imported");
	});
});

describe("imported connector storage", () => {
	it("keeps a credential out of the catalog file", async () => {
		const agentDir = await fs.promises.mkdtemp(path.join(tmpdir(), "musepi-connector-import-"));
		const connectorsDir = path.join(agentDir, "connectors");
		await fs.promises.mkdir(connectorsDir, { recursive: true });
		const { writeCustomEntries, readCustomEntries, connectorCustomPath } = await import("./import");

		await writeCustomEntries(
			[
				{
					id: "local-thing",
					name: "Local thing",
					description: "Imported from cursor.",
					auth: { mode: "token" },
					tokenSchema: {
						fields: [{ key: "header:authorization", label: "authorization", type: "password", required: true }],
					},
					source: connectorCustomPath(agentDir),
					sourceKind: "index",
				},
			],
			agentDir,
		);

		const text = await fs.promises.readFile(connectorCustomPath(agentDir), "utf8");
		// The catalog records which credential fields exist, never their values.
		expect(text).toContain("header:authorization");
		expect(text).not.toContain("Bearer");

		const entries = await readCustomEntries(agentDir);
		expect(entries.map(entry => entry.id)).toEqual(["local-thing"]);
	});
});
