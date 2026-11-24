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

	it("carries a query-parameter key in the URL and a header key in a header", () => {
		const queryKey: ConnectorCatalogEntry = {
			id: "query-key",
			name: "Query key",
			description: "key travels in the query string",
			server: { type: "http", url: "https://query.example/mcp" },
			auth: { mode: "token" },
			tokenSchema: {
				fields: [{ key: "Key", label: "Key", type: "password", required: true }],
				query: "key",
			},
			source: "/tmp/catalog.json",
			sourceKind: "index",
		};
		const headerKey: ConnectorCatalogEntry = {
			id: "header-key",
			name: "Header key",
			description: "key travels in a header",
			server: { type: "http", url: "https://header.example/mcp" },
			auth: { mode: "token" },
			tokenSchema: { fields: [{ key: "Token", label: "Token", type: "password", required: true }] },
			source: "/tmp/catalog.json",
			sourceKind: "index",
		};

		const [queryServer, headerServer] = projectConnectorServers(
			[queryKey, headerKey],
			state({ "query-key": true, "header-key": true }),
			{
				"query-key": { Key: "a b&c" },
				"header-key": { Token: "secret" },
			},
		);

		// The value is escaped, so it cannot introduce a second parameter.
		expect(queryServer?.url).toBe("https://query.example/mcp?key=a+b%26c");
		expect(queryServer?.headers).toBeUndefined();
		expect(headerServer?.headers).toEqual({ Authorization: "Bearer secret" });
		expect(headerServer?.url).toBe("https://header.example/mcp");
	});

	it("mounts an OAuth row only once its client id and secret are stored", () => {
		const entry: ConnectorCatalogEntry = {
			id: "github",
			name: "GitHub",
			description: "needs a registered app",
			server: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
			auth: { mode: "oauth" },
			tokenSchema: {
				fields: [
					{ key: "GITHUB_CLIENT_ID", label: "Client ID", type: "text", required: true },
					{ key: "GITHUB_CLIENT_SECRET", label: "Client secret", type: "password", required: true },
				],
				oauthClient: { clientIdField: "GITHUB_CLIENT_ID", clientSecretField: "GITHUB_CLIENT_SECRET" },
			},
			source: "/tmp/catalog.json",
			sourceKind: "index",
		};
		const state = { version: 1 as const, connectors: { github: { enabled: true } } };

		expect(projectConnectorServers([entry], state)).toHaveLength(0);
		// Half a client is still no client.
		expect(projectConnectorServers([entry], state, { github: { GITHUB_CLIENT_ID: "Iv1.abc" } })).toHaveLength(0);

		const [server] = projectConnectorServers([entry], state, {
			github: { GITHUB_CLIENT_ID: "Iv1.abc", GITHUB_CLIENT_SECRET: "s3cret" },
		});
		expect(server?.oauth).toEqual({ clientId: "Iv1.abc", clientSecret: "s3cret" });
		expect(server?.auth).toEqual({ type: "oauth", clientId: "Iv1.abc" });
	});

	it("mounts an OAuth row with only a pasted token, and prefers the token over nothing", () => {
		const entry: ConnectorCatalogEntry = {
			id: "github",
			name: "GitHub",
			description: "device code or a pasted token",
			server: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
			auth: { mode: "oauth" },
			oauth: { clientId: "Iv1.example" },
			tokenSchema: {
				fields: [],
				personalAccessToken: { field: "GITHUB_TOKEN" },
			},
			source: "/tmp/catalog.json",
			sourceKind: "index",
		};
		const state = { version: 1 as const, connectors: { github: { enabled: true } } };

		// The row mounts on its own: the pinned client id is enough for the
		// device grant, and the token is only needed when that path is out.
		const [server] = projectConnectorServers([entry], state, { github: { GITHUB_TOKEN: "ghp_secret" } });
		expect(server?.headers).toEqual({ Authorization: "Bearer ghp_secret" });
		expect(server?.headerPolicy).toBe("origin-locked");
		expect(server?.oauth?.clientId).toBe("Iv1.example");
	});

	it("does not mount a row that needs an OAuth client when only a token is missing", () => {
		const entry: ConnectorCatalogEntry = {
			id: "needs-client",
			name: "Needs a client",
			description: "no client, no token",
			server: { type: "http", url: "https://client.example/mcp" },
			auth: { mode: "oauth" },
			tokenSchema: {
				fields: [],
				oauthClient: { clientIdField: "CLIENT_ID", clientSecretField: "CLIENT_SECRET" },
				personalAccessToken: { field: "GITHUB_TOKEN" },
			},
			source: "/tmp/catalog.json",
			sourceKind: "index",
		};
		const state = { version: 1 as const, connectors: { "needs-client": { enabled: true } } };

		expect(projectConnectorServers([entry], state)).toHaveLength(0);
		// Half a client is still no client.
		expect(projectConnectorServers([entry], state, { "needs-client": { CLIENT_ID: "Iv1.abc" } })).toHaveLength(0);
		// A pasted token answers the row on its own.
		expect(projectConnectorServers([entry], state, { "needs-client": { GITHUB_TOKEN: "ghp_secret" } })).toHaveLength(
			1,
		);
	});

	it("keeps the OAuth grant ahead of a pasted token", () => {
		const entry: ConnectorCatalogEntry = {
			id: "github",
			name: "GitHub",
			description: "both a grant and a token",
			server: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
			auth: { mode: "oauth" },
			tokenSchema: {
				fields: [],
				personalAccessToken: { field: "GITHUB_TOKEN" },
			},
			source: "/tmp/catalog.json",
			sourceKind: "index",
		};
		const state = { version: 1 as const, connectors: { github: { enabled: true } } };
		const [server] = projectConnectorServers([entry], state, { github: { GITHUB_TOKEN: "ghp_secret" } });
		// The manager overwrites a same-named header when an OAuth grant
		// exists, so the token is only a fallback.
		expect(server?.headers?.Authorization).toBe("Bearer ghp_secret");
	});

	it("drops a query-key connector until its key is configured", () => {
		const entry: ConnectorCatalogEntry = {
			id: "unset",
			name: "Unset",
			description: "no key yet",
			server: { type: "http", url: "https://unset.example/mcp" },
			auth: { mode: "token" },
			tokenSchema: { fields: [{ key: "Key", label: "Key", type: "password" }], query: "key" },
			source: "/tmp/catalog.json",
			sourceKind: "index",
		};
		expect(projectConnectorServers([entry], state({ unset: true }))).toHaveLength(0);
	});

	it("carries the read-only switch onto the projected server", () => {
		const readOnlyState: ConnectorStateFile = {
			version: 1,
			connectors: { alpha: { enabled: true, readOnly: true }, beta: { enabled: true } },
		};
		const servers = projectConnectorServers([alpha, beta], readOnlyState);
		expect(servers.find(server => server.name === "connector:alpha")?.readOnlyTools).toBe(true);
		// A connector without the switch keeps every tool it offers.
		expect(servers.find(server => server.name === "connector:beta")?.readOnlyTools).toBeUndefined();
	});
});
