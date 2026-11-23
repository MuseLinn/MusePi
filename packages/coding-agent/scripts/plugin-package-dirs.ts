import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";

/**
 * Every plugin package directory under a source tree, as `[domain, package]`
 * pairs.
 *
 * Two layouts are accepted, because the trees that get staged do not all use
 * the same one: the host's own plugins are grouped by domain
 * (`plugins/<domain>/<package>`, mirroring the reference harness's
 * `packages/<domain>/<package>`), while the desktop plugins are flat
 * (`plugins/<package>`). A directory holding a `package.json` is a package; any
 * other directory is a domain and is looked into one level. That test reads the
 * disk rather than trusting a root's convention, so a package that moves between
 * layouts does not need this list updated.
 */
export function pluginPackageDirs(root: string): Array<{ domain: string; name: string; dir: string }> {
	const out: Array<{ domain: string; name: string; dir: string }> = [];
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return out;
	}
	const isPackage = (dir: string): boolean => {
		try {
			return statSync(path.join(dir, "package.json")).isFile();
		} catch {
			return false;
		}
	};
	for (const name of entries) {
		const candidate = path.join(root, name);
		try {
			if (!statSync(candidate).isDirectory()) continue;
		} catch {
			continue;
		}
		if (isPackage(candidate)) {
			out.push({ domain: "", name, dir: candidate });
			continue;
		}
		for (const nested of readdirSync(candidate)) {
			const pkgDir = path.join(candidate, nested);
			try {
				if (!statSync(pkgDir).isDirectory()) continue;
			} catch {
				continue;
			}
			if (isPackage(pkgDir)) out.push({ domain: name, name: nested, dir: pkgDir });
		}
	}
	return out;
}
