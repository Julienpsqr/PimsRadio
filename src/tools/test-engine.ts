// SPDX-License-Identifier: AGPL-3.0-or-later
// `npm run test:engine`: proves, with real containers, that the generated Liquidsoap
// script plays, that Icecast serves it, and that the output never goes silent
// (spec 002). Requires Docker. Exit codes: 0 all OK, 1 a criterion failed, 2 environment.
// Test audio is synthesised by Liquidsoap itself (sine tones); nothing is downloaded.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineError } from "../engine/engine.js";
import { generateScript, lqString, type LiquidsoapConfig } from "../engine/liquidsoap.js";
import { LiquidsoapEngine } from "../engine/liquidsoap-engine.js";
import type { Asset } from "../library/library.js";
import { analyze, countDominant, longestSilence, parseWav, type Window } from "./engine-test/analyze.js";

const PROJECT = "pimsradio-test";
const LABEL = "pimsradio.test=1";
const ICECAST_PORT = 18000;
const HARBOR_PORT = 18005;
const TELNET_PORT = 11234;
const BITRATE = 128;
const BYTES_PER_SEC = (BITRATE * 1000) / 8;
const FREQS = [440, 880, 1320] as const;
const [F_FALLBACK, F_QUEUE, F_LIVE] = [0, 1, 2] as const;
const GLOBAL_TIMEOUT_MS = 8 * 60_000;
const SETTLE = 3; // seconds ignored after the start of a capture
const MIN_FRACTION = 0.8;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const composeFile = join(root, "deploy", "docker-compose.dev.yml");
const lockFile = join(tmpdir(), "pimsradio-test-engine.lock");

class EnvError extends Error {}

// ---------------------------------------------------------------- output (masked)
const secrets: string[] = [];
const printed: string[] = [];
function mask(s: string): string {
  let out = s;
  for (const sec of secrets) out = out.split(sec).join("***");
  return out;
}
function log(s: string): void {
  const m = mask(s);
  printed.push(m);
  console.log(m);
}

// ---------------------------------------------------------------- helpers
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t0 = performance.now();
const elapsed = () => ((performance.now() - t0) / 1000).toFixed(0) + "s";

interface Exec { code: number; out: string }
function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<Exec> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: env ?? process.env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

interface Ctx {
  runDir: string;
  env: NodeJS.ProcessEnv;
  lqImage: string;
  icePw: string;
  harborPw: string;
}
let ctx: Ctx | undefined;
let cleaned = false;
let haveLock = false;

const docker = (args: string[], timeoutMs?: number) => run("docker", args, undefined, timeoutMs);
const compose = (args: string[], timeoutMs?: number) =>
  run("docker", ["compose", "-p", PROJECT, "-f", composeFile, ...args], ctx?.env ?? composeEnv("/nonexistent", "x", "x"), timeoutMs);

function composeEnv(runDir: string, icePw: string, harborPw: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PIMS_ICECAST_PORT: String(ICECAST_PORT),
    PIMS_HARBOR_PORT: String(HARBOR_PORT),
    PIMS_TELNET_PORT: String(TELNET_PORT),
    PIMS_ENGINE_DIR: join(runDir, "engine"),
    PIMS_MEDIA_DIR: join(runDir, "media"),
    ICECAST_SOURCE_PASSWORD: icePw,
    ICECAST_ADMIN_PASSWORD: "test-" + randomBytes(12).toString("hex"),
    ICECAST_RELAY_PASSWORD: "test-" + randomBytes(12).toString("hex"),
  };
}

function composeImage(service: string): string {
  const text = readFileSync(composeFile, "utf8");
  const m = new RegExp(`^  ${service}:\\n(?:    .*\\n|\\s*\\n)*?    image:\\s*(\\S+)`, "m").exec(text);
  if (!m?.[1]) throw new Error(`no image for ${service} in compose`);
  return m[1];
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

function acquireLock(): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockFile, String(process.pid), { flag: "wx" });
      haveLock = true;
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(lockFile, "utf8"));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /* stale lock */ }
      if (alive) throw new EnvError(`another test:engine run is active (pid ${pid})`);
      unlinkSync(lockFile);
    }
  }
  throw new EnvError("cannot acquire lock " + lockFile);
}

async function removeLabelled(): Promise<void> {
  const ids = (await docker(["ps", "-aq", "--filter", `label=${LABEL}`])).out.split(/\s+/).filter(Boolean);
  if (ids.length) await docker(["rm", "-f", ...ids]);
}

async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  if (!haveLock) return; // never touch the project of a concurrent run
  // Order matters: the emitter container is outside the compose project but attached to its
  // network, so it must go first or the network cannot be removed (QA-2).
  await removeLabelled();
  await compose(["down", "-v", "--remove-orphans", "-t", "2"], 90_000);
  await removeLabelled(); // an emitter started while we were tearing down
  await docker(["network", "rm", `${PROJECT}_default`]); // no-op (error ignored) when compose already removed it
  if (ctx) rmSync(ctx.runDir, { recursive: true, force: true });
  if (haveLock) try { unlinkSync(lockFile); } catch { /* already gone */ }
}

// ---------------------------------------------------------------- results
interface Result { id: number; name: string; ok: boolean; detail: string }
const results: Result[] = [];
function record(id: number, name: string, ok: boolean, detail: string): void {
  results.push({ id, name, ok, detail });
  log(`  [${ok ? "OK" : "KO"}] ${String(id).padStart(2)}  ${name}: ${detail}  (${elapsed()})`);
}

// ---------------------------------------------------------------- engine access
function icecastStatus(): Promise<{ mounts: Array<Record<string, unknown>> } | undefined> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: ICECAST_PORT, path: "/status-json.xsl", timeout: 3000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { icestats?: { source?: unknown } };
          const src = j.icestats?.source;
          resolve({ mounts: (Array.isArray(src) ? src : src ? [src] : []) as Array<Record<string, unknown>> });
        } catch { resolve(undefined); }
      });
    });
    req.on("error", () => resolve(undefined));
    req.on("timeout", () => { req.destroy(); resolve(undefined); });
  });
}
async function radioMount(): Promise<Record<string, unknown> | undefined> {
  const st = await icecastStatus();
  return st?.mounts.find((m) => typeof m["listenurl"] === "string" && m["listenurl"].endsWith("/radio"));
}
async function waitForMount(timeoutS: number): Promise<number | undefined> {
  const start = performance.now();
  while ((performance.now() - start) / 1000 < timeoutS) {
    if (await radioMount()) return (performance.now() - start) / 1000;
    await sleep(500);
  }
  return undefined;
}

/** Continuous capture of the MP3 stream, with position markers in stream seconds. */
class Capture {
  private chunks: Buffer[] = [];
  private bytes = 0;
  contentType = "";
  private req?: http.ClientRequest;
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.req = http.get({ host: "127.0.0.1", port: ICECAST_PORT, path: "/radio" }, (res) => {
        this.contentType = String(res.headers["content-type"] ?? "");
        res.on("data", (c: Buffer) => { this.chunks.push(c); this.bytes += c.length; });
        res.on("error", () => { /* stream ended */ });
        resolve();
      });
      this.req.on("error", reject);
    });
  }
  mark(): number { return this.bytes / BYTES_PER_SEC; }
  size(): number { return this.bytes; }
  stop(): Buffer { this.req?.destroy(); return Buffer.concat(this.chunks); }
}

async function decode(mp3: Buffer, name: string): Promise<Window[]> {
  const c = ctx!;
  writeFileSync(join(c.runDir, "captures", `${name}.mp3`), mp3);
  const r = await docker(["run", "--rm", "--label", LABEL, "-v", `${c.runDir}:/run`, c.lqImage, "/run/decode.liq", "--",
    `/run/captures/${name}.mp3`, `/run/captures/${name}.wav`]);
  const wavPath = join(c.runDir, "captures", `${name}.wav`);
  if (!existsSync(wavPath)) throw new Error(`decode failed: ${r.out.split("\n").filter((l) => /error/i.test(l)).slice(0, 3).join(" | ")}`);
  return analyze(parseWav(readFileSync(wavPath)), FREQS);
}

/** Raw telnet exchange: send commands, collect each answer up to END, then `exit`. */
async function telnet(commands: string[], timeoutMs = 8000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: TELNET_PORT });
    const answers: string[] = [];
    let buf = "";
    let idx = 0;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("telnet timeout")); }, timeoutMs);
    const next = () => {
      if (idx < commands.length) sock.write(commands[idx] + "\n");
      else sock.write("exit\n");
    };
    sock.on("connect", next);
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      if (idx >= commands.length) { if (buf.includes("Bye!")) sock.end(); return; }
      const m = /^([\s\S]*?)\r?\nEND\r?\n/.exec(buf);
      if (m) {
        answers.push((m[1] ?? "").trim());
        buf = buf.slice(m[0].length);
        idx++;
        next();
      }
    });
    sock.on("close", () => { clearTimeout(timer); resolve(answers); });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

function fmtDominance(hits: number, total: number): string { return `${hits}/${total} windows`; }
function expectTone(ws: Window[], idx: number, from: number, to: number, label: string): { ok: boolean; detail: string } {
  const { hits, total } = countDominant(ws, idx, from, to);
  return { ok: total > 0 && hits / total >= MIN_FRACTION, detail: `${label} ${FREQS[idx]} Hz in [${from.toFixed(0)},${to.toFixed(0)}]s: ${fmtDominance(hits, total)}` };
}

// ---------------------------------------------------------------- scenario
function scriptConfig(overrides: Partial<LiquidsoapConfig> = {}, c = ctx!): LiquidsoapConfig {
  return {
    icecastHost: "icecast", icecastPort: 8000, icecastPassword: c.icePw, mount: "/radio",
    fallbackDir: "/media/fallback", telnetPort: 1234, harborPort: 8005, harborPassword: c.harborPw,
    bitrateKbps: BITRATE, ...overrides,
  };
}

async function checkScript(file: string): Promise<Exec> {
  const c = ctx!;
  return docker(["run", "--rm", "--label", LABEL, "-v", `${c.runDir}:/run:ro`, c.lqImage, "--check", file]);
}

async function criterion1(): Promise<boolean> {
  const c = ctx!;
  writeFileSync(join(c.runDir, "engine", "radio.liq"), generateScript(scriptConfig()));
  const good = await checkScript("/run/engine/radio.liq");
  const noisy = /\b(error|warning|unbound|unknown|deprecated)\b/i.test(good.out);
  writeFileSync(join(c.runDir, "bad.liq"), generateScript(scriptConfig()) + "\nthis_function_does_not_exist(1)\n");
  const bad = await checkScript("/run/bad.liq");
  writeFileSync(join(c.runDir, "weird.liq"), generateScript(scriptConfig({ fallbackDir: '/media/we"ird\\dir with spaces' })));
  const weird = await checkScript("/run/weird.liq");
  // QA-1: a value containing the interpolation `#{system(...)}` must stay literal when really executed.
  const marker = "pwned-by-interpolation";
  writeFileSync(join(c.runDir, "inject.liq"), `x = ${lqString(`a#{system("touch /run/${marker}")}b`)}
print("RESULT=" ^ x)
`);
  const inj = await docker(["run", "--rm", "--label", LABEL, "-v", `${c.runDir}:/run`, c.lqImage, "/run/inject.liq"]);
  const injectionSafe = inj.out.includes(`RESULT=a#{system("touch /run/${marker}")}b`) && !existsSync(join(c.runDir, marker));
  const ok = good.code === 0 && !noisy && bad.code !== 0 && weird.code === 0 && injectionSafe;
  record(1, "script valid", ok,
    `--check rc=${good.code}${noisy ? " (warnings in output: " + good.out.split("\n").filter((l) => /error|warning|unknown|deprecated/i.test(l)).slice(0, 2).join(" | ") + ")" : ""}; tampered script rc=${bad.code} (must be non-zero); path with quote/backslash rc=${weird.code}; #{system()} interpolation stays literal: ${injectionSafe}`);
  if (!ok) log(good.out.split("\n").filter((l) => !/\[(startup|main|sdl|video|audio)/.test(l)).slice(0, 15).join("\n"));
  return ok;
}

async function generateAudio(): Promise<void> {
  const c = ctx!;
  const media = join(c.runDir, "media");
  for (const d of ["fallback", "queue"]) mkdirSync(join(media, d), { recursive: true });
  writeFileSync(join(c.runDir, "gen.liq"), `# test tone generator: gen.liq -- freq seconds outfile
freq = float_of_string(argv(1))
s = sine(duration=float_of_string(argv(2)), freq)
clock.assign_new(sync="none", [s])
output.file(%mp3(bitrate=${BITRATE}), argv(3), s, fallible=true, on_stop=shutdown)
`);
  writeFileSync(join(c.runDir, "decode.liq"), `# decode.liq -- in.mp3 out.wav
s = once(single(argv(1)))
clock.assign_new(sync="none", [s])
output.file(%wav(channels=1, samplerate=8000), argv(2), s, fallible=true, on_stop=shutdown)
`);
  const jobs: Array<[number, number, string]> = [
    [440, 20, "fallback/a.mp3"], [440, 20, "fallback/b.mp3"],
    [880, 8, "queue/q.mp3"], [880, 4, "queue/q2.mp3"], [880, 70, "queue/long.mp3"],
    // spec 001: a name with spaces and a double quote, and two files for the concurrency check
    [880, 6, 'queue/we ird "q" name.mp3'], [880, 5, "queue/c1.mp3"], [880, 5, "queue/c2.mp3"],
  ];
  const outs = await Promise.all(jobs.map(([f, d, n]) =>
    docker(["run", "--rm", "--label", LABEL, "-v", `${c.runDir}:/run`, c.lqImage, "/run/gen.liq", "--", String(f), String(d), `/run/media/${n}`])));
  jobs.forEach(([, , n], i) => {
    if (!existsSync(join(media, n))) throw new Error(`tone generation failed for ${n}: ${outs[i]?.out.slice(-300)}`);
  });
  writeFileSync(join(media, "queue", "bad.mp3"), randomBytes(2048));
  chmodSync(join(media, "queue", "bad.mp3"), 0o644);
}

let liveSeq = 0;
async function startEmitter(freq: number, password: string): Promise<string> {
  const c = ctx!;
  const n = ++liveSeq;
  writeFileSync(join(c.runDir, `live${n}.liq`), `s = sine(${freq}.)
output.icecast(%mp3(bitrate=64), host="liquidsoap", port=8005, mount="live", password=${lqString(password)}, s)
`);
  const name = `${PROJECT}-live-${n}`;
  const r = await docker(["run", "-d", "--rm", "--name", name, "--label", LABEL, "--network", `${PROJECT}_default`,
    "-v", `${c.runDir}:/run:ro`, c.lqImage, `/run/live${n}.liq`]);
  if (r.code !== 0) throw new Error("cannot start emitter: " + r.out.slice(-200));
  return name;
}


// ---------------------------------------------------------------- spec 001: LiquidsoapEngine against the real engine
function e2eAsset(rel: string, title: string, durationS: number, id: number): Asset {
  return {
    id, kind: "music", path: join(ctx!.runDir, "media", rel), title, artist: "Test", durationS,
    language: null, loudnessLufs: null, tags: [],
  };
}

async function waitUntil(cond: () => Promise<boolean>, timeoutMs: number, stepMs = 400): Promise<number | undefined> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (await cond().catch(() => false)) return (performance.now() - start) / 1000;
    await sleep(stepMs);
  }
  return undefined;
}

/** Run one criterion; an exception is a KO with its message, never a crash of the whole run. */
async function guarded(id: number, name: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<void> {
  try {
    const r = await fn();
    record(id, name, r.ok, r.detail);
  } catch (e) {
    record(id, name, false, "exception: " + mask(e instanceof Error ? e.message : String(e)));
  }
}

async function engineScenario(): Promise<void> {
  const c = ctx!;
  const mediaRoot = join(c.runDir, "media");
  const assets = new Map<string, Asset>();
  const reg = (a: Asset): Asset => { assets.set(a.path, a); return a; };
  const q = reg(e2eAsset("queue/q.mp3", "Tone Q", 8, 101));
  const q2 = reg(e2eAsset("queue/q2.mp3", "Tone Q2", 4, 102));
  const long = reg(e2eAsset("queue/long.mp3", "Tone Long", 70, 103));
  const weird = reg(e2eAsset('queue/we ird "q" name.mp3', 'Tone "weird" name', 6, 104));
  const c1 = reg(e2eAsset("queue/c1.mp3", "Tone C1", 5, 105));
  const c2 = reg(e2eAsset("queue/c2.mp3", "Tone C2", 5, 106));
  const make = () => new LiquidsoapEngine({
    host: "127.0.0.1", port: TELNET_PORT, mediaRoot, engineMediaRoot: "/media", resolve: (p) => assets.get(p),
  });
  let engine = make();
  engine.start();
  const isAuto = async () => (await engine.state()).source === "auto";

  log("Engine client (spec 001):");
  const ce = new Capture();
  await ce.start();
  await sleep(4000);

  // 17 (first half) and 16: fallback state, push, queue
  const st0 = await engine.state().catch((e: Error) => e);
  const mP = ce.mark();
  const pushQ = await engine.push(q).then(() => "ok", (e: Error) => e.message);
  const tAuto = await waitUntil(isAuto, 12_000);
  const stAuto = await engine.state().catch((e: Error) => e);
  const pushQ2 = await engine.push(q2).then(() => "ok", (e: Error) => e.message);
  const ahead = await engine.queuedSeconds().catch(() => NaN);
  const nextUp = await engine.next().catch(() => null);
  await sleep(14_000);

  // direct
  const emitter = await startEmitter(1320, c.harborPw);
  const tDirect = await waitUntil(async () => (await engine.state()).source === "direct", 25_000);
  const stDirect = await engine.state().catch((e: Error) => e);
  const mDirect = ce.mark();
  await docker(["rm", "-f", emitter]);
  const tBack = await waitUntil(async () => (await engine.state()).source === "fallback", 25_000);
  const stBack = await engine.state().catch((e: Error) => e);
  const skipOnFallback = await engine.skip().catch((e: Error) => e);

  // 18: skip a long track
  const mLong = ce.mark();
  await engine.push(long);
  await waitUntil(isAuto, 12_000);
  await sleep(8000);
  const mSkip = ce.mark();
  const skipRes = await engine.skip().catch((e: Error) => e);
  const tLeft = await waitUntil(async () => (await engine.state()).source !== "auto", 10_000);
  await sleep(9000);

  // 19: paths
  const rawBefore = await telnet(["request.all"]).catch((e: Error) => [e.message]);
  const hostile = ["/media/x.mp3\nrequest.all", "/media/x.mp3\r\nrequest.all", "annotate:a=\"b\":/media/x.mp3", "process:ls", "/media/../etc/passwd"];
  const hostileCodes: string[] = [];
  for (const h of hostile) {
    hostileCodes.push(await engine.push({ ...q, path: h.startsWith("/media") && !h.includes("..") ? mediaRoot + h.slice("/media".length) : h })
      .then(() => "accepted", (e: unknown) => (e instanceof EngineError ? e.code : "other")));
  }
  const rawAfter = await telnet(["request.all"]).catch((e: Error) => [e.message]);
  const mW = ce.mark();
  const weirdPush = await engine.push(weird).then(() => "ok", (e: unknown) => (e instanceof EngineError ? e.code : "other"));
  await sleep(9000);
  const lqRunning = (await docker(["inspect", "-f", "{{.State.Running}}", `${PROJECT}-liquidsoap-1`])).out.trim() === "true";

  // 22: two clients pushing at the same time
  const other = make();
  other.start();
  const mC = ce.mark();
  const both = await Promise.allSettled([engine.push(c1), other.push(c2)]);
  const ridsSeen = await telnet(["request.all"]).catch(() => [""]);
  await other.close();
  await sleep(13_000);

  // 21: control plane restart with a long track playing and three waiting
  await waitUntil(async () => (await engine.state()).source === "fallback", 25_000); // the previous tracks are done
  await engine.push(long);
  await waitUntil(async () => (await engine.state()).current?.title === "Tone Long", 12_000);
  await sleep(3000);
  await engine.push(q);
  await engine.push(q2);
  await engine.push(weird);
  const sumBefore = await engine.queuedSeconds().catch(() => NaN);
  const mSwap = ce.mark();
  await engine.close(); // the client dies, then a fresh one is born with an empty ledger
  engine = make();
  engine.start();
  const sumAfter = await engine.queuedSeconds().catch(() => NaN);
  const qAfter = await engine.queue().catch(() => []);
  const nextAfter = await engine.next().catch(() => null);
  await sleep(5000);
  const mSwapEnd = ce.mark();

  const ws = await decode(ce.stop(), "engine-e2e");

  await guarded(16, "engine push and queue", async () => {
    const hits = countDominant(ws, F_QUEUE, mP, mP + 16).hits;
    const ok = pushQ === "ok" && pushQ2 === "ok" && hits >= 12 && Number.isFinite(ahead) && Math.abs(ahead - 4) <= 1;
    return { ok, detail: `push q then q2 (8 s + 4 s); queuedSeconds=${Number.isFinite(ahead) ? ahead : "error"} (expected 4 +/- 1: only q2 waits); 880 Hz dominant in ${hits} windows (>= 12 expected); auto after ${tAuto?.toFixed(1)} s; push results ${pushQ}/${pushQ2}` };
  });

  await guarded(17, "engine state and next", async () => {
    const s0 = st0 instanceof Error ? undefined : st0;
    const sa = stAuto instanceof Error ? undefined : stAuto;
    const sd = stDirect instanceof Error ? undefined : stDirect;
    const sb = stBack instanceof Error ? undefined : stBack;
    const ok = s0?.source === "fallback" && /^[ab]$/.test(s0.current?.title ?? "") && s0.current?.assetId === null
      && sa?.source === "auto" && sa.current?.title === "Tone Q" && sa.current.assetId === 101
      && nextUp?.title === "Tone Q2" && nextUp.assetId === 102
      && sd?.source === "direct" && sd.current === null && sb?.source === "fallback"
      && !(skipOnFallback instanceof Error) && skipOnFallback.skipped === false;
    return { ok, detail: `empty queue: ${s0?.source}/"${s0?.current?.title}"; playing: ${sa?.source}/"${sa?.current?.title}"; next: "${nextUp?.title}"; live: ${sd?.source} after ${tDirect?.toFixed(1)} s (mark ${mDirect.toFixed(0)}); after live: ${sb?.source} after ${tBack?.toFixed(1)} s; skip on fallback: ${JSON.stringify(skipOnFallback instanceof Error ? skipOnFallback.message : skipOnFallback)}` };
  });

  await guarded(18, "engine skip", async () => {
    const before = expectTone(ws, F_QUEUE, mLong + 4, mSkip - 2, "before skip");
    const after = expectTone(ws, F_FALLBACK, mSkip + 4, mSkip + 8, "after skip");
    const ok = before.ok && after.ok && !(skipRes instanceof Error) && skipRes.skipped === true && tLeft !== undefined;
    return { ok, detail: `skip=${JSON.stringify(skipRes instanceof Error ? skipRes.message : skipRes)}; left auto after ${tLeft?.toFixed(1)} s; ${before.detail}; ${after.detail}` };
  });

  await guarded(19, "engine paths", async () => {
    const played = countDominant(ws, F_QUEUE, mW, mW + 12).hits;
    const sameRequests = (rawBefore[0] ?? "") === (rawAfter[0] ?? "") && rawBefore.length === 1;
    const ok = hostileCodes.every((x) => x === "invalid_input") && sameRequests && lqRunning && (weirdPush === "ok" ? played >= 8 : weirdPush === "invalid_input");
    return { ok, detail: `hostile paths -> ${hostileCodes.join("/")}; request.all unchanged: ${sameRequests}; liquidsoap running: ${lqRunning}; name with spaces and quotes: push ${weirdPush}, 880 Hz in ${played} windows (>= 8 expected if played)` };
  });

  await guarded(22, "engine concurrent clients", async () => {
    const played = countDominant(ws, F_QUEUE, mC, mC + 18).hits;
    const [a, b] = both;
    const ok = a.status === "fulfilled" && b.status === "fulfilled" && played >= 16;
    return { ok, detail: `two clients pushed ${a.status}/${b.status}; request.all="${(ridsSeen[0] ?? "").replace(/\s+/g, " ")}"; 880 Hz dominant in ${played} windows (>= 16 expected for 2 x 5 s)` };
  });

  await guarded(21, "engine control plane restart", async () => {
    const expected = 8 + 4 + 6;
    const silence = longestSilence(ws.filter((w) => w.start >= mSwap - 4 && w.start < mSwapEnd), 0);
    const tone = expectTone(ws, F_QUEUE, mSwap - 3, mSwapEnd - 1, "around the swap");
    const resolved = qAfter.length === 3 && qAfter.every((i) => i.assetId !== null);
    const ok = Math.abs(sumBefore - expected) <= 1.5 && Math.abs(sumAfter - expected) <= 1.5 && resolved && silence <= 2 && tone.ok
      && nextAfter?.title === "Tone Q";
    return { ok, detail: `queuedSeconds before=${sumBefore}, new client=${sumAfter} (expected ${expected} +/- 1.5); rebuilt from the library: ${resolved} (${qAfter.map((i) => i.title).join(", ")}); next="${nextAfter?.title}"; longest silence ${silence} s; ${tone.detail}` };
  });

  // 20: engine outage and return (the queue is lost with the engine: expected)
  await guarded(20, "engine outage and return", async () => {
    await compose(["stop", "-t", "2", "liquidsoap"]);
    const tDown = await waitUntil(async () => !(await engine.healthy()), 10_000, 300);
    const t0 = performance.now();
    const pushErr = await engine.push(q).then(() => "accepted", (e: unknown) => (e instanceof EngineError ? e.code : "other"));
    const qErr = await engine.queuedSeconds().then(() => "number", (e: unknown) => (e instanceof EngineError ? e.code : "other"));
    const fast = performance.now() - t0;
    await compose(["start", "liquidsoap"]);
    const tUp = await waitUntil(() => engine.healthy(), 25_000, 500);
    const mount = await waitForMount(30);
    let toneDetail = "mount did not reappear";
    let toneOk = false;
    if (mount !== undefined) {
      const c5 = new Capture();
      await c5.start();
      await sleep(9000);
      const w5 = await decode(c5.stop(), "engine-outage");
      const e = expectTone(w5, F_FALLBACK, SETTLE, 9, "after the outage");
      toneOk = e.ok;
      toneDetail = e.detail;
    }
    const ok = tDown !== undefined && tDown <= 5 && pushErr !== "accepted" && qErr !== "number" && fast < 4000 && tUp !== undefined && tUp <= 20 && toneOk;
    return { ok, detail: `healthy() false after ${tDown?.toFixed(1)} s (<= 5); push -> ${pushErr}, queuedSeconds -> ${qErr}, answered in ${(fast / 1000).toFixed(1)} s; healthy() true again ${tUp?.toFixed(1)} s after the restart without recreating the client (<= 20); ${toneDetail}` };
  });
  await engine.close();
}

async function main(): Promise<number> {
  // pre-flight
  const info = await docker(["info", "--format", "{{.ServerVersion}}"], 20_000);
  if (info.code !== 0) throw new EnvError("Docker unavailable (is the daemon running?)");
  for (const p of [ICECAST_PORT, HARBOR_PORT, TELNET_PORT]) {
    if (!(await portFree(p))) throw new EnvError(`port ${p} is already in use`);
  }
  acquireLock();

  const icePw = "test-" + randomBytes(12).toString("hex");
  const harborPw = "test-" + randomBytes(12).toString("hex");
  secrets.push(icePw, harborPw);
  const runDir = mkdtempSync(join(tmpdir(), "pimsradio-engine-"));
  chmodSync(runDir, 0o711); // traversable by the container user, not listable
  // engine is mounted read-only (readable only); captures and media are written by containers.
  for (const [d, mode] of [["engine", 0o755], ["captures", 0o777], ["media", 0o777]] as const) {
    mkdirSync(join(runDir, d));
    chmodSync(join(runDir, d), mode);
  }
  ctx = { runDir, env: composeEnv(runDir, icePw, harborPw), lqImage: composeImage("liquidsoap"), icePw, harborPw };
  const env = ctx.env;
  secrets.push(String(env.ICECAST_ADMIN_PASSWORD), String(env.ICECAST_RELAY_PASSWORD));

  log(`PimsRadio engine test - docker ${info.out.trim()}, images: ${ctx.lqImage}, ${composeImage("icecast")}`);
  await compose(["down", "-v", "--remove-orphans", "-t", "2"], 90_000); // leftovers of a previous run

  for (const img of [ctx.lqImage, composeImage("icecast")]) {
    if ((await docker(["image", "inspect", img])).code !== 0) {
      const p = await docker(["pull", "-q", img], 600_000);
      if (p.code !== 0) throw new EnvError(`cannot pull ${img}: ${p.out.slice(-200)}`);
    }
  }

  const timer = setTimeout(() => {
    log("TIMEOUT: global limit of 8 minutes reached, forcing cleanup");
    void cleanup().finally(() => process.exit(1));
  }, GLOBAL_TIMEOUT_MS);
  timer.unref();

  log("Checks:");
  if (!(await criterion1())) return 1;
  await generateAudio();

  let failedLogs = false;
  const up = await compose(["up", "-d"], 120_000);
  if (up.code !== 0) throw new EnvError("compose up failed: " + up.out.slice(-400));
  const ready = await waitForMount(60);
  if (ready === undefined) {
    log("Stack not ready after 60 s; container logs follow");
    log((await compose(["logs", "--no-color", "--tail", "60"])).out);
    record(3, "icecast receives and serves", false, "mount /radio did not appear within 60 s");
    return 1;
  }

  // Phase A: criteria 3 and 4 (fallback, queue empty)
  const cap = new Capture();
  await cap.start();
  await sleep(5000);
  const mount = await radioMount();
  const okMount = !!mount && mount["server_type"] === "audio/mpeg" && String(mount["listenurl"]).includes("/radio");
  const bytes5 = cap.size();
  record(3, "icecast receives and serves", okMount && cap.contentType.startsWith("audio/mpeg") && bytes5 >= 16 * 1024,
    `mount ${mount ? String(mount["server_type"]) : "absent"}, Content-Type ${cap.contentType || "?"}, ${bytes5} bytes in 5 s, ready after ${ready.toFixed(1)} s`);
  await sleep(6000);

  // Phase B: telnet push, then back to fallback (criteria 5, 6)
  const mB = cap.mark();
  let pushDetail = "";
  let pushOk = false;
  try {
    const [r1, r2, queue, all] = await telnet([`auto.push /media/queue/q.mp3`, `auto.push /media/queue/q2.mp3`, "auto.queue", "request.all"]);
    const rid1 = /^\d+$/.test(r1 ?? "") ? r1! : "";
    const rid2 = /^\d+$/.test(r2 ?? "") ? r2! : "";
    const listed = rid2 !== "" && (queue ?? "").split(/\s+/).includes(rid2);
    const inAll = rid1 !== "" && (all ?? "").split(/\s+/).includes(rid1);
    pushOk = rid1 !== "" && rid2 !== "" && rid1 !== rid2 && listed && inAll;
    pushDetail = `RIDs ${r1}/${r2}, auto.queue="${(queue ?? "").replace(/\s+/g, " ")}", request.all="${(all ?? "").replace(/\s+/g, " ")}"`;
  } catch (e) { pushDetail = "telnet error: " + (e as Error).message; }
  await sleep(27_000);

  // Phase C: priority queue > fallback, live > queue (criteria 7, 8)
  const mC = cap.mark();
  const pushLong = await telnet(["auto.push /media/queue/long.mp3"]).catch((e: Error) => [e.message]);
  await sleep(10_000);
  const mD = cap.mark();
  const live = await startEmitter(1320, ctx.harborPw);
  await sleep(14_000);
  const mE = cap.mark();
  const bad = await startEmitter(1760, "wrong-" + randomBytes(6).toString("hex"));
  await sleep(8000);
  const badLogs = (await docker(["logs", bad])).out;
  await docker(["rm", "-f", bad]);
  const mF = cap.mark();
  await docker(["rm", "-f", live]);
  await sleep(14_000);
  const mG = cap.mark();
  const skip = await telnet(["auto.skip"]).catch((e: Error) => [e.message]);
  await sleep(12_000);

  // Phase D: invalid files (criterion 9), two concurrent telnet connections
  const mH = cap.mark();
  const [pa, pb] = await Promise.all([
    telnet(["auto.push /media/queue/bad.mp3"]).catch((e: Error) => [e.message]),
    telnet(["auto.push /media/queue/does-not-exist.mp3"]).catch((e: Error) => [e.message]),
  ]);
  await sleep(12_000);
  const running = (await docker(["inspect", "-f", "{{.State.Running}}", `${PROJECT}-liquidsoap-1`])).out.trim() === "true";
  const startedBefore = (await docker(["inspect", "-f", "{{.State.StartedAt}}", `${PROJECT}-liquidsoap-1`])).out.trim();
  const total = cap.mark();
  const mp3 = cap.stop();

  log(`Captured ${total.toFixed(0)} s of audio, decoding...`);
  const ws = await decode(mp3, "main");

  const e4 = expectTone(ws, F_FALLBACK, SETTLE, 10, "fallback");
  const s4 = longestSilence(ws.filter((w) => w.start < mB), SETTLE);
  record(4, "fallback plays when queue is empty", e4.ok && s4 <= 0, `${e4.detail}; longest silence ${s4} s`);

  const e5 = countDominant(ws, F_QUEUE, mB, mB + 16);
  record(5, "telnet push plays the file", pushOk && e5.hits >= 12, `${pushDetail}; 880 Hz dominant in ${e5.hits} windows (>= 12 expected)`);

  const e6 = expectTone(ws, F_FALLBACK, mB + 18, mB + 26, "fallback after queue");
  const s6 = longestSilence(ws.filter((w) => w.start >= mB && w.start < mC), 0);
  record(6, "return to fallback", e6.ok && s6 <= 2, `${e6.detail}; longest silence ${s6} s`);

  const a = expectTone(ws, F_QUEUE, mC + 5, mD, "queue");
  const b = expectTone(ws, F_LIVE, mD + 8, mE, "live");
  const c = expectTone(ws, F_QUEUE, mF + 8, mG, "queue after live");
  const d = expectTone(ws, F_FALLBACK, mG + 6, mH, "fallback after skip");
  const s7 = longestSilence(ws.filter((w) => w.start >= mC && w.start < mH), 0);
  record(7, "priority live > queue > fallback", a.ok && b.ok && c.ok && d.ok && s7 <= 2 && /^\d+$/.test(pushLong[0] ?? ""),
    `${[a, b, c, d].map((x) => (x.ok ? "ok " : "KO ") + x.detail).join("; ")}; skip="${(skip[0] ?? "").slice(0, 30)}"; longest silence ${s7} s`);

  const h = expectTone(ws, F_LIVE, mE + 2, mF, "live during wrong-password attempt");
  const rejected = /(\b401\b|forbidden|invalid password|wrong password|unauthori|Connection failed|authent)/i.test(badLogs);
  record(8, "harbor password enforced", h.ok, `${h.detail}; emitter log shows rejection: ${rejected ? "yes" : "no (" + badLogs.split("\n").filter((l) => /error|fail|denied/i.test(l)).slice(-1)[0] + ")"}`);

  const e9 = expectTone(ws, F_FALLBACK, mH + 4, total, "fallback after invalid pushes");
  const s9 = longestSilence(ws.filter((w) => w.start >= mH), 0);
  const ridsOk = /^\d+$/.test(pa[0] ?? "") && /^\d+$/.test(pb[0] ?? "") && pa[0] !== pb[0];
  record(9, "invalid file pushed", e9.ok && s9 <= 2 && running && ridsOk,
    `${e9.detail}; liquidsoap running=${running}; RIDs ${pa[0]}/${pb[0]}; longest silence ${s9} s`);

  const sAll = longestSilence(ws, SETTLE);
  record(10, "never silent", total >= 90 && sAll <= 2, `capture ${total.toFixed(0)} s (>= 90 expected), longest run below -50 dBFS: ${sAll} s (<= 2 expected)`);

  // Criterion 11: Icecast restart (Liquidsoap untouched)
  await compose(["stop", "-t", "2", "icecast"]);
  await sleep(2000);
  await compose(["start", "icecast"]);
  const back = await waitForMount(30);
  let d11 = back === undefined ? "mount /radio did not reappear within 30 s" : `mount back after ${back.toFixed(1)} s`;
  let ok11 = false;
  if (back !== undefined) {
    const c2 = new Capture();
    await c2.start();
    await sleep(9000);
    const w2 = await decode(c2.stop(), "icecast-restart");
    const live2 = w2.filter((w) => w.start >= SETTLE && w.rmsDb > -50).length;
    const startedAfter = (await docker(["inspect", "-f", "{{.State.StartedAt}}", `${PROJECT}-liquidsoap-1`])).out.trim();
    ok11 = live2 >= 8 && startedAfter === startedBefore;
    d11 += `; ${live2} non-silent windows in [3,9] s; liquidsoap not restarted: ${startedAfter === startedBefore}`;
  }
  record(11, "icecast reconnection", ok11, d11);

  // Criterion 12: Liquidsoap restart
  const rs = performance.now();
  await compose(["restart", "-t", "2", "liquidsoap"]);
  await sleep(1500);
  const back12 = await waitForMount(30);
  let ok12 = false;
  let d12 = "mount /radio did not reappear within 30 s";
  if (back12 !== undefined) {
    const c3 = new Capture();
    await c3.start();
    await sleep(9000);
    const w3 = await decode(c3.stop(), "lq-restart");
    const e = expectTone(w3, F_FALLBACK, SETTLE, 9, "after restart");
    const delay = (performance.now() - rs) / 1000 - 9;
    ok12 = e.ok && delay <= 30;
    d12 = `flow back ${delay.toFixed(1)} s after restart; ${e.detail}`;
  }
  record(12, "engine restart", ok12, d12);


  // ------------------------------------------------------------------ Phase E (spec 001): the real LiquidsoapEngine
  await engineScenario();

  // Criterion 13: empty fallback folder (documented limit: silence is expected)
  for (const f of ["a.mp3", "b.mp3"]) rmSync(join(ctx.runDir, "media", "fallback", f), { force: true });
  await compose(["restart", "-t", "2", "liquidsoap"]);
  await sleep(1500);
  const back13 = await waitForMount(30);
  let ok13 = false;
  let d13 = "mount /radio did not reappear within 30 s";
  if (back13 !== undefined) {
    const c4 = new Capture();
    await c4.start();
    await sleep(6000);
    const size = c4.size();
    c4.stop();
    const still = await radioMount();
    ok13 = !!still && size >= 16 * 1024;
    d13 = `source still listed: ${!!still}; ${size} bytes in 6 s (silence expected, audio not checked)`;
  }
  record(13, "empty fallback (documented limit)", ok13, d13);

  // Criterion 15 (before teardown): ports bound to localhost only
  const ports = (await docker(["ps", "--filter", `label=com.docker.compose.project=${PROJECT}`, "--format", "{{.Ports}}"])).out;
  const bindings = ports.split(/[,\n]/).map((s) => s.trim()).filter((s) => s.includes("->"));
  const open = bindings.filter((s) => !s.startsWith("127.0.0.1:"));
  const ISOLATED = ![8000, 8005, 1234].some((p) => [ICECAST_PORT, HARBOR_PORT, TELNET_PORT].includes(p));
  failedLogs = results.some((r) => !r.ok);
  if (failedLogs) {
    log("Some checks failed; container logs follow (passwords masked):");
    log((await compose(["logs", "--no-color", "--tail", "80"])).out);
  }
  const leaked = secrets.some((s) => printed.join("\n").includes(s));
  record(15, "isolation", bindings.length >= 3 && open.length === 0 && ISOLATED && !leaked,
    `${bindings.length} published ports, non-localhost: ${open.length}, test ports differ from dev ports: ${ISOLATED}, password in output: ${leaked}`);
  clearTimeout(timer);
  return 0;
}

async function summary(exit: number): Promise<number> {
  // Criterion 14, measured after teardown.
  const leftovers = [
    (await docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${PROJECT}`])).out.trim(),
    (await docker(["ps", "-aq", "--filter", `label=${LABEL}`])).out.trim(),
    (await docker(["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${PROJECT}`])).out.trim(),
    (await docker(["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${PROJECT}`])).out.trim(),
  ];
  const dirGone = !ctx || !existsSync(ctx.runDir);
  if (ctx) record(14, "cleanup", leftovers.every((l) => l === "") && dirGone, `containers/networks/volumes left: ${leftovers.filter(Boolean).length}, temp dir removed: ${dirGone}`);
  const bad = results.filter((r) => !r.ok);
  log("");
  log(`Result: ${results.length - bad.length}/${results.length} criteria OK in ${elapsed()}.${bad.length ? " KO: " + bad.map((r) => r.id).join(", ") : ""}`);
  return exit === 0 && bad.length > 0 ? 1 : exit;
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { log(`${sig}: cleaning up`); void cleanup().finally(() => process.exit(130)); });
}

let code = 0;
try {
  code = await main();
} catch (e) {
  if (e instanceof EnvError) {
    log("ENVIRONMENT: " + e.message);
    code = 2;
  } else {
    log("ERROR: " + mask(e instanceof Error ? (e.stack ?? e.message) : String(e)));
    code = 1;
  }
  if (ctx) log((await compose(["logs", "--no-color", "--tail", "60"]).catch(() => ({ out: "" }))).out);
} finally {
  await cleanup();
}
process.exit(await summary(code));
