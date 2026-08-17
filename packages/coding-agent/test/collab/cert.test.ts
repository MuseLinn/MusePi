import { afterEach, describe, expect, it } from "bun:test";
import { X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { ensureLanCertificate } from "../../src/collab/cert";

const SAN_IPS_RE = /(?:^|,\s*)IP Address:([^,\s]+)/g;

function sanIps(certPem: string): string[] {
	const cert = new X509Certificate(certPem);
	return [...(cert.subjectAltName ?? "").matchAll(SAN_IPS_RE)].map(m => m[1]!);
}

function withTempConfig<T>(fn: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-cert-test-"));
	try {
		process.env.XDG_CONFIG_HOME = dir;
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

afterEach(() => {
	delete process.env.XDG_CONFIG_HOME;
});

describe("ensureLanCertificate", () => {
	it("generates a parseable self-signed cert with the LAN IP in SAN", () => {
		withTempConfig(() => {
			const cert = ensureLanCertificate(["192.168.7.9"]);
			expect(sanIps(cert.certPem)).toContain("192.168.7.9");
			expect(cert.keyPem).toContain("BEGIN PRIVATE KEY");
		});
	});

	it("reuses the persisted cert for the same IP", () => {
		withTempConfig(() => {
			const a = ensureLanCertificate(["192.168.7.9"]);
			const b = ensureLanCertificate(["192.168.7.9"]);
			expect(a.certPem).toBe(b.certPem);
		});
	});

	it("regenerates when the LAN IP changed", () => {
		withTempConfig(() => {
			const a = ensureLanCertificate(["192.168.7.9"]);
			const b = ensureLanCertificate(["10.1.2.3"]);
			expect(a.certPem).not.toBe(b.certPem);
			expect(sanIps(b.certPem)).toContain("10.1.2.3");
		});
	});

	it("covers every current IP in one SAN (LAN + Tailscale)", () => {
		withTempConfig(() => {
			const cert = ensureLanCertificate(["192.168.7.9", "100.64.5.9"]);
			const ips = sanIps(cert.certPem);
			expect(ips).toContain("192.168.7.9");
			expect(ips).toContain("100.64.5.9");
			// Reuse while the IP set is unchanged.
			expect(ensureLanCertificate(["100.64.5.9", "192.168.7.9"]).certPem).toBe(cert.certPem);
			// Adding an IP forces a regen.
			expect(ensureLanCertificate(["192.168.7.9", "100.64.5.9", "10.0.0.4"]).certPem).not.toBe(cert.certPem);
		});
	});

	it("serves TLS: a client handshake succeeds against the generated key/cert", () => {
		withTempConfig(() => {
			const cert = ensureLanCertificate(["127.0.0.1"]);
			const server = tls.createServer({ key: cert.keyPem, cert: cert.certPem }, sock => {
				sock.end();
				server.close();
			});
			return new Promise<void>((resolve, reject) => {
				server.listen(0, "127.0.0.1", () => {
					const port = (server.address() as { port: number }).port;
					const client = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
						expect(client.authorized).toBe(false); // self-signed — never trusted by default
						client.end();
						resolve();
					});
					client.on("error", reject);
				});
			});
		});
	});
});
