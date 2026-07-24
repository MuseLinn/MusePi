#!/usr/bin/env node

/**
 * Bump versions for MusePi-owned packages only.
 * Upstream packages (@earendil-works/pi-*) keep their original versions.
 *
 * Our packages (lockstep):
 *   - @earendil-works/pi-coding-agent (our CLI)
 *   - @musepi/core
 *   - @musepi/transcript
 *   - @earendil-works/pi-orchestrator (if we keep it)
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const OURS = [
  'packages/coding-agent',
  'packages/orchestrator',
  'packages/musepi/core',
  'packages/musepi/transcript',
];

const bump = process.argv[2] ?? 'patch'; // patch | minor | major

// 1. Bump our packages
const versionMap = {};
for (const dir of OURS) {
  const pkgPath = join(root, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const parts = pkg.version.split('.').map(Number);
  if (bump === 'patch') parts[2]++;
  else if (bump === 'minor') { parts[1]++; parts[2] = 0; }
  else if (bump === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  pkg.version = parts.join('.');
  writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
  versionMap[dir] = pkg.version;
  console.log(`${pkg.name}  ${pkg.version}`);
}

// 2. Scan all packages for version map (including upstream for dep resolution)
const allPkgs = {};
for (const dir of readdirSync(join(root, 'packages'))) {
  try {
    const p = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
    allPkgs[p.name] = p.version;
  } catch {}
}
// Also scan musepi subdirs
try {
  for (const dir of readdirSync(join(root, 'packages', 'musepi'))) {
    try {
      const p = JSON.parse(readFileSync(join(root, 'packages', 'musepi', dir, 'package.json'), 'utf8'));
      allPkgs[p.name] = p.version;
    } catch {}
  }
} catch {}

console.log('\n✅ All package versions:');
for (const [name, v] of Object.entries(allPkgs).sort()) {
  console.log(`  ${name}: ${v}`);
}

// 3. Update inter-package deps across ALL packages (so coding-agent's deps stay in sync)
let totalUpdates = 0;
for (const dir of readdirSync(join(root, 'packages'))) {
  try {
    const pkgPath = join(root, 'packages', dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    let updated = false;
    for (const section of ['dependencies', 'devDependencies']) {
      if (!pkg[section]) continue;
      for (const [depName, currentVersion] of Object.entries(pkg[section])) {
        if (allPkgs[depName]) {
          const newVersion = `^${allPkgs[depName]}`;
          if (currentVersion !== newVersion) {
            console.log(`\n${pkg.name}: ${depName}: ${currentVersion} → ${newVersion}`);
            pkg[section][depName] = newVersion;
            updated = true;
            totalUpdates++;
          }
        }
      }
    }
    // Also scan musepi subdirs
    if (updated) writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
  } catch {}
}
try {
  for (const dir of readdirSync(join(root, 'packages', 'musepi'))) {
    try {
      const pkgPath = join(root, 'packages', 'musepi', dir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      let updated = false;
      for (const section of ['dependencies', 'devDependencies']) {
        if (!pkg[section]) continue;
        for (const [depName, currentVersion] of Object.entries(pkg[section])) {
          if (allPkgs[depName]) {
            const newVersion = `^${allPkgs[depName]}`;
            if (currentVersion !== newVersion) {
              console.log(`\n${pkg.name}: ${depName}: ${currentVersion} → ${newVersion}`);
              pkg[section][depName] = newVersion;
              updated = true;
              totalUpdates++;
            }
          }
        }
      }
      if (updated) writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
    } catch {}
  }
} catch {}

if (totalUpdates === 0) console.log('\nAll inter-package dependencies already in sync.');
else console.log(`\n✅ Updated ${totalUpdates} dependency version(s)`);
