/**
 * Self-signed ECDSA P-256 certificate for the LAN collab relay's TLS port.
 *
 * Browsers only expose WebCrypto (`crypto.subtle`) in secure contexts
 * (https or localhost), so a plain-http LAN page can never run the collab
 * AES-GCM sealing. The LAN share therefore serves the web UI over https
 * with a self-signed certificate generated here — one-time browser
 * warning, then the page auto-connects. The certificate is persisted under
 * `<configRoot>/collab/` and regenerated only when the machine's LAN IPv4
 * changes (the SAN must match the exact IP the browser visits).
 *
 * Zero-dependency: macOS ships LibreSSL which lacks openssl's `-addext`,
 * so the X.509 v3 DER is encoded by hand (node:crypto supplies the EC
 * keypair, the SPKI blob and the ECDSA-SHA256 signature).
 */
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigRootDir } from "@musepi/pi-utils";

export interface LanCertificate {
	keyPem: string;
	certPem: string;
}

const CERT_FILE = "collab-lan-cert.pem";
const KEY_FILE = "collab-lan-key.pem";

// ── DER primitives ──────────────────────────────────────────────────────────

function derLength(len: number): Uint8Array {
	if (len < 0x80) return Uint8Array.of(len);
	if (len < 0x100) return Uint8Array.of(0x81, len);
	if (len < 0x10000) return Uint8Array.of(0x82, len >> 8, len & 0xff);
	throw new Error("DER length too large");
}

function tlv(tag: number, body: Uint8Array): Uint8Array {
	const len = derLength(body.length);
	const out = new Uint8Array(1 + len.length + body.length);
	out[0] = tag;
	out.set(len, 1);
	out.set(body, 1 + len.length);
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	let size = 0;
	for (const p of parts) size += p.length;
	const out = new Uint8Array(size);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

const seq = (...parts: Uint8Array[]) => tlv(0x30, concat(...parts));
const set = (...parts: Uint8Array[]) => tlv(0x31, concat(...parts));
const bitString = (bytes: Uint8Array) => tlv(0x03, concat(Uint8Array.of(0), bytes));
const octetString = (bytes: Uint8Array) => tlv(0x04, bytes);

/** Non-negative INTEGER, with a leading zero when the top bit is set. */
function derInteger(n: bigint): Uint8Array {
	const raw: number[] = [];
	let v = n;
	while (v > 0n) {
		raw.unshift(Number(v & 0xffn));
		v >>= 8n;
	}
	if (raw.length === 0) raw.push(0);
	if (raw[0] & 0x80) raw.unshift(0);
	return tlv(0x02, Uint8Array.from(raw));
}

function derOid(oid: number[]): Uint8Array {
	const parts: number[] = [40 * oid[0]! + oid[1]!];
	for (let i = 2; i < oid.length; i++) {
		let v = oid[i]!;
		const stack: number[] = [v & 0x7f];
		v >>= 7;
		while (v > 0) {
			stack.unshift(0x80 | (v & 0x7f));
			v >>= 7;
		}
		parts.push(...stack);
	}
	return tlv(0x06, Uint8Array.from(parts));
}

function derUtcTime(d: Date): Uint8Array {
	const pad = (n: number) => String(n).padStart(2, "0");
	const s = `${pad(d.getUTCFullYear() % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(
		d.getUTCHours(),
	)}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
	return tlv(0x17, new TextEncoder().encode(s));
}

const derUtf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));

// ── X.509 v3 self-signed certificate ────────────────────────────────────────

const OID_ECDSA_SHA256 = derOid([1, 2, 840, 10045, 4, 3, 2]);
/** AlgorithmIdentifier wrapping the ecdsa-with-SHA256 OID (SEQUENCE { OID }). */
const ECDSA_SHA256_ALG = seq(OID_ECDSA_SHA256);
const OID_CN = derOid([2, 5, 4, 3]);
const OID_SAN = derOid([2, 5, 29, 17]);
const OID_BASIC_CONSTRAINTS = derOid([2, 5, 29, 19]);
const OID_KEY_USAGE = derOid([2, 5, 29, 15]);

function derName(commonName: string): Uint8Array {
	return seq(set(seq(OID_CN, derUtf8(commonName))));
}

/** Build a self-signed leaf certificate covering every IP (SAN IP:… ×N). */
function buildCertificate(ips: string[]): { certDer: Uint8Array; keyPem: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));

	const serial = randomBytes(16).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
	const name = derName("musepi-collab lan");
	const notBefore = new Date(Date.now() - 24 * 3600 * 1000);
	const notAfter = new Date(Date.now() + 3650 * 24 * 3600 * 1000);
	const ipEntries = ips.map(ip => tlv(0x87, Uint8Array.from(ip.split(".").map(Number)))); // [7] iPAddress
	const san = seq(...ipEntries);
	const ext = (oid: Uint8Array, value: Uint8Array, critical = false): Uint8Array =>
		critical ? seq(oid, tlv(0x01, Uint8Array.of(0xff)), octetString(value)) : seq(oid, octetString(value));
	const extensions = seq(
		ext(OID_SAN, san),
		ext(OID_BASIC_CONSTRAINTS, seq()), // CA:FALSE
		ext(OID_KEY_USAGE, bitString(Uint8Array.of(0x88)), true), // digitalSignature + keyAgreement (MSB-first bits)
	);

	const tbs = seq(
		tlv(0xa0, derInteger(2n)), // version v3
		derInteger(serial),
		ECDSA_SHA256_ALG,
		name, // issuer
		seq(derUtcTime(notBefore), derUtcTime(notAfter)),
		name, // subject
		spki,
		tlv(0xa3, extensions), // [3] EXPLICIT Extensions
	);

	const signature = new Uint8Array(sign("sha256", tbs, privateKey)); // DER ECDSA-Sig-Value
	const certDer = seq(tbs, ECDSA_SHA256_ALG, bitString(signature));
	return { certDer, keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
}

function derToPem(der: Uint8Array, label: string): string {
	const b64 = Buffer.from(der).toString("base64");
	const lines = b64.match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** SAN IP addresses (e.g. "IP Address:192.168.1.5") from a cert's subjectAltName. */
function sanIps(cert: X509Certificate): string[] {
	const san = cert.subjectAltName ?? "";
	return [...san.matchAll(/(?:^|,\s*)IP Address:([^,\s]+)/g)].map(m => m[1]!);
}

/**
 * Load or create the LAN certificate covering every current IP. Regenerates
 * when the persisted certificate lacks any current IP (network change,
 * Tailscale join/leave) or expired.
 */
export function ensureLanCertificate(ips: string[]): LanCertificate {
	const dir = path.join(getConfigRootDir(), "collab");
	const certPath = path.join(dir, CERT_FILE);
	const keyPath = path.join(dir, KEY_FILE);

	let certPem: string | null = null;
	let keyPem: string | null = null;
	try {
		certPem = fs.readFileSync(certPath, "utf8");
		keyPem = fs.readFileSync(keyPath, "utf8");
		const parsed = new X509Certificate(certPem);
		const have = new Set(sanIps(parsed));
		if (ips.every(ip => have.has(ip)) && new Date(parsed.validTo) > new Date()) {
			return { keyPem, certPem };
		}
	} catch {
		// missing or unreadable — regenerate below
	}

	const { certDer, keyPem: freshKey } = buildCertificate(ips);
	const freshCert = derToPem(certDer, "CERTIFICATE");
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(certPath, freshCert, { mode: 0o644 });
		fs.writeFileSync(keyPath, freshKey, { mode: 0o600 });
	} catch {
		// persistence is best-effort; a fresh in-memory cert still works for this run
	}
	return { keyPem: freshKey, certPem: freshCert };
}
