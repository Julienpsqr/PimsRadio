// SPDX-License-Identifier: AGPL-3.0-or-later
// Fails (exit 1) if a dependency in package-lock.json has a missing, unknown or
// disallowed license. No dependency. Usage: node scripts/check-licenses.mjs
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Explicit allow-list (SPDX identifiers), compatible with AGPL-3.0-or-later.
export const ALLOWED = [
  "MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC", "0BSD",
  "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later",
  "GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "AGPL-3.0-or-later",
];

/** Normalises legacy aliases such as "Apache 2.0" is NOT guessed: unknown stays unknown. */
function tokenize(expr) {
  return expr.replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
}

/**
 * Evaluates a simple SPDX expression: ids joined by OR / AND (no parentheses nesting
 * semantics beyond left-to-right precedence AND > OR). Returns true if allowed.
 */
export function isAllowed(expr, allowed = ALLOWED) {
  if (typeof expr !== "string" || expr.trim() === "") return false;
  const set = new Set(allowed);
  const tokens = tokenize(expr);
  // Split on OR into alternatives; each alternative is ids joined by AND.
  const alternatives = [[]];
  for (const t of tokens) {
    if (t === "OR") alternatives.push([]);
    else if (t !== "AND") alternatives[alternatives.length - 1].push(t);
  }
  return alternatives.some((alt) => alt.length > 0 && alt.every((id) => set.has(id)));
}

/** Returns [{ name, version, license, ok }] for every package of a parsed lockfile. */
export function collect(lock, readManifestLicense = () => undefined, allowed = ALLOWED) {
  const rows = [];
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    let license = info.license;
    if (typeof license !== "string") license = readManifestLicense(path);
    rows.push({
      name,
      version: info.version ?? "?",
      license: typeof license === "string" ? license : "(absente)",
      ok: isAllowed(license, allowed),
    });
  }
  return rows;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const fromManifest = (path) => {
    const file = join(root, path, "package.json");
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")).license;
  };
  const rows = collect(lock, fromManifest);
  console.table(rows.map((r) => ({ ...r, ok: r.ok ? "OK" : "REFUSE" })));
  const bad = rows.filter((r) => !r.ok);
  if (bad.length > 0) {
    console.error(`Licences refusees ou inconnues : ${bad.map((r) => `${r.name}@${r.version} (${r.license})`).join(", ")}`);
    process.exit(1);
  }
  console.log(`${rows.length} dependance(s), licences compatibles AGPL-3.0-or-later.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
