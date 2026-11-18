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

/** Splits an SPDX expression into tokens: parentheses are their own tokens, the rest is split on whitespace. */
function tokenize(expr) {
  return expr.replace(/([()])/g, " $1 ").split(/\s+/).filter(Boolean);
}

/**
 * Evaluates an SPDX expression with a recursive-descent parser (fail-closed).
 * Grammar: expr = and ("OR" and)* ; and = primary ("AND" primary)* ;
 * primary = "(" expr ")" | id. AND binds tighter than OR. Operators are upper-case only.
 * "WITH" (exceptions) is not supported and therefore refused. Any malformed
 * expression, trailing token or non-string input returns false.
 */
export function isAllowed(expr, allowed = ALLOWED) {
  if (typeof expr !== "string" || expr.trim() === "") return false;
  const set = new Set(allowed);
  const tokens = tokenize(expr);
  let pos = 0;
  const fail = () => { throw new SyntaxError("invalid SPDX expression"); };
  const primary = () => {
    const t = tokens[pos++];
    if (t === undefined) return fail();
    if (t === "(") {
      const v = orExpr();
      if (tokens[pos++] !== ")") fail();
      return v;
    }
    if (t === ")" || t === "AND" || t === "OR" || t === "WITH") return fail();
    return set.has(t);
  };
  const andExpr = () => {
    let v = primary();
    while (tokens[pos] === "AND") { pos++; const r = primary(); v = v && r; }
    return v;
  };
  const orExpr = () => {
    let v = andExpr();
    while (tokens[pos] === "OR") { pos++; const r = andExpr(); v = v || r; }
    return v;
  };
  try {
    const v = orExpr();
    if (pos !== tokens.length) return false;
    return v;
  } catch (e) {
    if (e instanceof SyntaxError) return false;
    throw e;
  }
}

/**
 * Returns [{ name, version, license, ok }] for every package of a parsed lockfile.
 * Throws if the lockfile has no "packages" map (lockfileVersion 1 or truncated).
 * Symlink entries ("link": true) are skipped: their target is listed on its own.
 * Entries outside node_modules (workspaces) are checked under their own name or path.
 */
export function collect(lock, readManifestLicense = () => undefined, allowed = ALLOWED) {
  const pkgs = lock?.packages;
  if (typeof pkgs !== "object" || pkgs === null || Array.isArray(pkgs)) {
    throw new Error("package-lock.json sans cle \"packages\" (lockfileVersion >= 2 requis)");
  }
  const marker = "node_modules/";
  const rows = [];
  for (const [path, info] of Object.entries(pkgs)) {
    if (path === "") continue;
    if (info?.link === true) continue;
    const i = path.lastIndexOf(marker);
    const name = i >= 0 ? path.slice(i + marker.length) : (info?.name ?? path);
    let license = info?.license;
    if (license === undefined) license = readManifestLicense(path);
    rows.push({
      name,
      version: info?.version ?? "?",
      license: typeof license === "string" ? license : license === undefined ? "(absente)" : "(invalide)",
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
  if (rows.length === 0) {
    console.error("Aucune dependance trouvee dans package-lock.json : verification impossible.");
    process.exit(1);
  }
  console.table(rows.map((r) => ({ ...r, ok: r.ok ? "OK" : "REFUSE" })));
  const bad = rows.filter((r) => !r.ok);
  if (bad.length > 0) {
    console.error(`Licences refusees ou inconnues : ${bad.map((r) => `${r.name}@${r.version} (${r.license})`).join(", ")}`);
    process.exit(1);
  }
  console.log(`${rows.length} dependance(s), licences compatibles AGPL-3.0-or-later.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
