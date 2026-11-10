import { describe, expect, it } from "bun:test";
import { isConnectorApproved, projectConnectorServers } from "./runtime";
import { type ConnectorCatalogEntry, type ConnectorStateFile, connectorCommandFingerprint } from "./types";

const alpha: ConnectorCatalogEntry = {
	id: "alpha",
	name: "Alpha",
	description: "remote",
	server: { type: "http", url: "https://alpha.example/mcp", headers: { "X-Static": "1" } },
	auth: { mode: "oauth" },
	source: "/tmp/catalog.json",
	sourceKind: "index",
};

const beta: ConnectorCatalogEntry = {
	id: "beta",
	name: "Beta",
	description: "open",
	server: { type: "sse", url: "https://beta.example/sse" },
	auth: { mode: "none" },
	source: "/tmp/catalog.json",
	sourceKind: "index",
};

function state(enabled: Record<string, boolean>): ConnectorStateFile {
	return {
		version: 1,
		connectors: Object.fromEntries(Object.entries(enabled).map(([id, value]) => [id, { enabled: value }])),
	};
}

describe("connector runtime projection", () => {
	it("projects only enabled entries into the connector namespace", () => {
		const servers = projectConnectorServers([alpha, beta], state({ alpha: true, beta: false }));
		expect(servers).toHaveLength(1);

		const [server] = servers;
		expect(server?.name).toBe("connector:alpha");
		expect(server?.transport).toBe("http");
		expect(server?.url).toBe("https://alpha.example/mcp");
		expect(server?.auth).toEqual({ type: "oauth" });
		expect(server?.headers).toEqual({ "X-Static": "1" });
		expect(server?.headerPolicy).toBe("origin-locked");
		expect(server?._source.provider).toBe("connector-catalog");
	});

	it("omits auth for open connectors and keeps the declared transport", () => {
		const servers = projectConnectorServers([beta], state({ beta: true }));
		expect(servers).toHaveLength(1);
		expect(servers[0]?.transport).toBe("sse");
		expect(servers[0]?.auth).toBeUndefined();
		expect(servers[0]?.headers).toBeUndefined();
	});

	it("projects nothing when state has no entry", () => {
		expect(projectConnectorServers([alpha, beta], state({}))).toEqual([]);
	});

	const tokenConnector: ConnectorCatalogEntry = {
		id: "gamma",
		name: "Gamma",
		description: "token",
		server: { type: "http", url: "https://gamma.example/mcp" },
		auth: { mode: "token" },
		tokenSchema: {
			fields: [{ key: "API_KEY", label: "API key", type: "password", required: true }],
		},
		source: "/tmp/catalog.json",
		sourceKind: "index",
	};

	it("injects the token header and skips an unconfigured token connector", () => {
		expect(projectConnectorServers([tokenConnector], state({ gamma: true }))).toEqual([]);

		const servers = projectConnectorServers([tokenConnector], state({ gamma: true }), {
			gamma: { API_KEY: "secret" },
		});
		expect(servers).toHaveLength(1);
		expect(servers[0]?.headers).toEqual({ Authorization: "Bearer secret" });
		expect(servers[0]?.headerPolicy).toBe("origin-locked");
	});

	it("supports a custom token header template and strips line breaks", () => {
		const custom: ConnectorCatalogEntry = {
			...tokenConnector,
			tokenSchema: {
				fields: [{ key: "TOKEN", label: "Token", type: "password" }],
				header: { name: "X-Api-Key", template: "${TOKEN}" },
			},
		};
		const servers = projectConnectorServers([custom], state({ gamma: true }), {
			gamma: { TOKEN: "a\r\nb" },
		});
		expect(servers[0]?.headers).toEqual({ "X-Api-Key": "ab" });
	});
	const stdioConnector: ConnectorCatalogEntry = {
		id: "stdio",
		name: "Stdio",
		description: "local",
		server: { type: "stdio", command: "npx", args: ["-y", "demo"], env: { A: "1" } },
		auth: { mode: "none" },
		source: "/tmp/catalog.json",
		sourceKind: "index",
	};

	it("mounts a stdio connector only after its command fingerprint is approved", () => {
		expect(projectConnectorServers([stdioConnector], state({ stdio: true }))).toEqual([]);

		const stdioServer = stdioConnector.server;
		if (stdioServer?.type !== "stdio") throw new Error("fixture must be stdio");
		const fingerprint = connectorCommandFingerprint(stdioServer);
		const approved: ConnectorStateFile = {
			version: 1,
			connectors: { stdio: { enabled: true, approvedCommand: fingerprint } },
		};
		expect(isConnectorApproved(stdioConnector, approved)).toBe(true);
		const servers = projectConnectorServers([stdioConnector], approved);
		expect(servers).toHaveLength(1);
		expect(servers[0]).toMatchObject({
			name: "connector:stdio",
			transport: "stdio",
			command: "npx",
			args: ["-y", "demo"],
			env: { A: "1" },
			envPolicy: "literal",
		});
	});
});
