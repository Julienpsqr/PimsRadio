// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db/db.js";
import { Library, type Asset } from "../library/library.js";
import { Grid } from "../scheduler/grid.js";
import { Planner } from "../scheduler/planner.js";
import { EngineError } from "./engine.js";
import { LiquidsoapEngine, type LiquidsoapEngineOptions } from "./liquidsoap-engine.js";
import { answer, type Conn, FakeServer, FakeTimers, makeAsset, turns, until } from "./test-support.js";

type Reply = string | ((conn: Conn) => void);
type Table = Record<string, Reply>;

/** A fake engine answering from a table (line to reply); anything else is an engine error line. */
const table = (t: Table) => (line: string, c: Conn): void => {
  const r = t[line];
  if (r === undefined) return c.write(answer(`ERROR: unknown command "${line.slice(0, 20)}"`));
  if (typeof r === "function") return r(c);
  c.write(r);
};

async function rig(t: Table = {}, over: Partial<LiquidsoapEngineOptions> = {}) {
  const server = await FakeServer.start(table(t));
  const timers = new FakeTimers();
  const engine = new LiquidsoapEngine({
    host: "127.0.0.1", port: server.port, timers, now: () => timers.now, random: () => 0.5, mediaRoot: "/media", ...over,
  });
  return { server, timers, engine, t, done: async () => { await engine.close(); await server.stop(); } };
}

const reject = async (p: Promise<unknown>): Promise<EngineError> => {
  try { await p; } catch (e) { assert.ok(e instanceof EngineError, String(e)); return e; }
  throw new Error("expected a rejection");
};
const meta = (rid: number, uri: string, extra = ""): string =>
  answer(`status="ready"\n${extra}initial_uri="${uri.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\nrid="${rid}"`, "\r\n");

test("1. push: exactly one line is sent, the promise resolves, RID 7 is booked against the asset", async () => {
  const { server, engine, done } = await rig({ "auto.push /media/a.mp3": answer("7"), "auto.queue": answer("7") });
  try {
    await engine.push(makeAsset("/media/a.mp3", 30));
    assert.deepEqual(server.lines, ["auto.push /media/a.mp3"]);
    assert.equal(server.bytes, Buffer.byteLength("auto.push /media/a.mp3\n"), "one line, one newline, nothing else");
    assert.equal(await engine.queuedSeconds(), 30, "RID 7 is known: no metadata command was needed");
    assert.deepEqual(server.lines, ["auto.push /media/a.mp3", "auto.queue"]);
  } finally { await done(); }
});

test("10. hostile paths are rejected invalid_input and not one byte reaches the server", async () => {
  const { server, engine, done } = await rig();
  try {
    const hostile = [
      "/media/x.mp3\nrequest.all", "/media/x.mp3\rrequest.all", "/media/x.mp3\r\nrequest.all", "/media/x\u0000.mp3",
      "/media/x\u0085.mp3", "/media/x\u2028.mp3", "/media/x\u2029.mp3", "/media/../etc/passwd.mp3", "/media/a/../b.mp3",
      "annotate:foo=\"bar\":/media/x.mp3", "process:foo", "http://example.org/x.mp3", "say:hello", "relative/x.mp3", "x.mp3",
      " /media/x.mp3", "/media/x.mp3 ", "/media/x\u007f.mp3", "/media/x\u001b[0m.mp3", "", "/media/\ud800.mp3",
    ];
    for (const p of hostile) {
      const e = await reject(engine.push(makeAsset(p, 10)));
      assert.equal(e.code, "invalid_input", JSON.stringify(p));
    }
    assert.equal(server.bytes, 0, "no byte was sent");
    assert.equal(server.connections, 0, "no connection was even opened");
  } finally { await done(); }
});

test("11. path length: 4096 bytes accepted; 4097 bytes and 1 MiB rejected without any send", async () => {
  const mk = (bytes: number): string => `/media/${"a".repeat(bytes - "/media/".length)}`;
  const long = mk(4096);
  const { server, engine, done } = await rig({ [`auto.push ${long}`]: answer("1") });
  try {
    await engine.push(makeAsset(long, 5));
    assert.equal(server.lines.length, 1);
    const before = server.bytes;
    assert.equal((await reject(engine.push(makeAsset(mk(4097), 5)))).code, "invalid_input");
    assert.equal((await reject(engine.push(makeAsset(mk(1024 * 1024), 5)))).code, "invalid_input");
    // Multi-byte characters count in bytes, not in characters.
    const wide = `/media/${"é".repeat(2045)}`; // 7 + 4090 = 4097 bytes, 2052 characters
    assert.equal((await reject(engine.push(makeAsset(wide, 5)))).code, "invalid_input");
    assert.equal(server.bytes, before);
  } finally { await done(); }
});

test("12. legitimate characters travel untouched on a single line ending with one newline", async () => {
  const names = [
    "/media/with space.mp3", '/media/say "hi".mp3', "/media/l'été.mp3", "/media/émoji \u{1F3B5}.mp3",
    "/media/track #1.mp3", "/media/{braces}.mp3", "/media/a#{b}.mp3", "/media/back\\slash.mp3",
  ];
  const t: Table = {};
  for (const n of names) t[`auto.push ${n}`] = answer("5");
  const { server, engine, done } = await rig(t);
  try {
    for (const n of names) await engine.push(makeAsset(n, 5));
    assert.deepEqual(server.lines, names.map((n) => `auto.push ${n}`));
    assert.equal(server.bytes, names.reduce((s, n) => s + Buffer.byteLength(`auto.push ${n}\n`), 0));
  } finally { await done(); }
});

test("13. a path outside the media root is refused; the root translation is applied", async () => {
  const { server, engine, done } = await rig({ "auto.push /media/sub/a b.mp3": answer("2") }, { mediaRoot: "/srv/data/", engineMediaRoot: "/media" });
  try {
    for (const p of ["/etc/passwd.mp3", "/srv/datax/a.mp3", "/srv/data", "/srv/other/a.mp3", "/srv/data/../etc/x.mp3"]) {
      assert.equal((await reject(engine.push(makeAsset(p, 5)))).code, "invalid_input", p);
    }
    assert.equal(server.bytes, 0);
    await engine.push(makeAsset("/srv/data/sub/a b.mp3", 5));
    assert.deepEqual(server.lines, ["auto.push /media/sub/a b.mp3"]);
  } finally { await done(); }
});

test("13b. unusable roots are refused at construction", () => {
  assert.throws(() => new LiquidsoapEngine({ host: "x", port: 1, mediaRoot: "media" }), EngineError);
  assert.throws(() => new LiquidsoapEngine({ host: "x", port: 1, mediaRoot: "/a/../b" }), EngineError);
  assert.throws(() => new LiquidsoapEngine({ host: "x", port: 1, engineMediaRoot: "/a\nb" }), EngineError);
});

test("15. an invalid answer to push is a protocol error: no success, nothing booked", async () => {
  for (const bad of [answer("Error: something went wrong"), answer(""), answer("7 8"), answer("7\n8"), answer("-1")]) {
    const { engine, server, done } = await rig({
      "auto.push /media/a.mp3": bad,
      "auto.queue": answer("7"),
      "request.metadata 7": meta(7, "/media/zzz.mp3"),
    });
    try {
      const e = await reject(engine.push(makeAsset("/media/a.mp3", 99)));
      assert.equal(e.code, "protocol");
      await engine.queuedSeconds();
      assert.ok(server.lines.includes("request.metadata 7"), "RID 7 was not in the ledger");
    } finally { await done(); }
  }
});

test("16. queuedSeconds: ledger sum, unknown RID resolved once through metadata, unresolved counts 0, empty is 0", async () => {
  const known = makeAsset("/media/known.mp3", 50);
  const lib = new Map<string, Asset>([[known.path, known]]);
  let queue = "3 4";
  const { server, engine, done } = await rig({
    "auto.push /media/a.mp3": answer("3"),
    "auto.push /media/b.mp3": answer("4"),
    "auto.queue": (c) => c.write(answer(queue)),
    "request.metadata 5": meta(5, "/media/known.mp3"),
    "request.metadata 6": meta(6, "/media/stranger.mp3"),
    "request.metadata 7": answer("No such request.", "\r\n"),
  }, { resolve: (p) => lib.get(p) });
  try {
    await engine.push(makeAsset("/media/a.mp3", 30));
    await engine.push(makeAsset("/media/b.mp3", 45));
    assert.equal(await engine.queuedSeconds(), 75);

    queue = "3 4 5";
    assert.equal(await engine.queuedSeconds(), 125, "the unknown RID 5 resolves to a 50 s asset");
    const metas = () => server.lines.filter((l) => l.startsWith("request.metadata")).length;
    assert.equal(metas(), 1);
    assert.equal(await engine.queuedSeconds(), 125);
    assert.equal(metas(), 1, "second read: no metadata command (memorised)");

    queue = "3 6 7";
    assert.equal(await engine.queuedSeconds(), 30, "unresolved RIDs count 0 s");
    const items = await engine.queue();
    assert.deepEqual(items.map((i) => [i.rid, i.durationS]), [[3, 30], [6, null], [7, null]]);
    assert.equal(items[1]!.title, "stranger", "unknown track is flagged and named after its file");

    queue = "";
    assert.equal(await engine.queuedSeconds(), 0, "empty queue");
  } finally { await done(); }
});

test("16b. concurrent reads share one queue command; an engine that cannot be reached is an error, never 0", async () => {
  const { server, engine, done } = await rig({ "auto.queue": answer("") });
  try {
    const [a, b] = await Promise.all([engine.queuedSeconds(), engine.queuedSeconds()]);
    assert.deepEqual([a, b], [0, 0]);
    assert.equal(server.lines.filter((l) => l === "auto.queue").length, 1);
  } finally { await done(); }
  const s = await FakeServer.start();
  const port = s.port;
  await s.stop();
  const dead = new LiquidsoapEngine({ host: "127.0.0.1", port, timers: new FakeTimers(), random: () => 0.5 });
  try {
    assert.equal((await reject(dead.queuedSeconds())).code, "unreachable");
    assert.equal((await reject(dead.push(makeAsset("/media/a.mp3", 5)))).code, "unreachable");
  } finally { await dead.close(); }
});

test("16c. garbage in the queue listing is a protocol error; the library throwing counts as unresolved; more than 50 unknown RIDs are capped", async () => {
  const garbage = await rig({ "auto.queue": answer("3 x4") });
  try { assert.equal((await reject(garbage.engine.queuedSeconds())).code, "protocol"); } finally { await garbage.done(); }

  const t: Table = { "auto.queue": answer(Array.from({ length: 60 }, (_, i) => i + 1).join(" ")) };
  for (let i = 1; i <= 60; i++) t[`request.metadata ${i}`] = meta(i, `/media/${i}.mp3`);
  let lookups = 0;
  const many = await rig(t, { resolve: () => { lookups++; throw new Error("db down"); } });
  try {
    assert.equal(await many.engine.queuedSeconds(), 0);
    assert.equal(many.server.lines.filter((l) => l.startsWith("request.metadata")).length, 50);
    assert.equal(lookups, 50);
  } finally { await many.done(); }
});

test("17. control plane restart: a fresh client sums the real queue and the planner pushes nothing more", async () => {
  const db = openDb(":memory:");
  const lib = new Library(db);
  const tracks = [100, 120, 140].map((d, i) => lib.add({ kind: "music", path: `/media/m${i}.mp3`, title: `T${i}`, artist: `A${i}`, durationS: d }));
  for (let i = 3; i < 8; i++) lib.add({ kind: "music", path: `/media/m${i}.mp3`, title: `T${i}`, artist: `A${i}`, durationS: 200 });
  const t: Table = { "auto.queue": answer("11 12 13") };
  tracks.forEach((a, i) => { t[`request.metadata ${11 + i}`] = meta(11 + i, a.path); });
  const { server, engine, done } = await rig(t, { resolve: (p) => lib.findByPath(p) });
  try {
    assert.equal(await engine.queuedSeconds(), 360, "sum of the three known durations");
    const planner = new Planner(db, new Grid(db), lib, engine, { timeZone: "Europe/Paris", targetAheadS: 300, rng: () => 0 });
    const r = await planner.tick(new Date("2026-07-01T10:00:00Z"));
    assert.equal(r.pushed, 0);
    assert.ok(!server.lines.some((l) => l.startsWith("auto.push")));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM play_log").get() as { n: number }).n, 0, "no row for tracks it did not push");
  } finally { await done(); }
});

test("18. an engine restart (uptime goes back) empties the RID cache", async () => {
  let uptime = "0d 00h 10m 00s";
  const lib = new Map<string, Asset>();
  const a = makeAsset("/media/a.mp3", 30);
  lib.set(a.path, a);
  const { server, engine, timers, done } = await rig({
    "auto.push /media/a.mp3": answer("7"),
    "auto.queue": answer("7"),
    uptime: (c) => c.write(answer(uptime)),
    "request.metadata 7": meta(7, "/media/a.mp3"),
  }, { resolve: (p) => lib.get(p) });
  try {
    await engine.push(a);
    await engine.queuedSeconds();
    const metas = () => server.lines.filter((l) => l.startsWith("request.metadata")).length;
    assert.equal(metas(), 0, "booked at push time");
    assert.equal(await engine.healthy(), true);
    timers.advance(2001);
    uptime = "0d 00h 00m 05s";
    assert.equal(await engine.healthy(), true);
    await engine.queuedSeconds();
    assert.equal(metas(), 1, "the ledger was emptied, RID 7 had to be looked up again");
    assert.equal(await engine.queuedSeconds(), 30);
  } finally { await done(); }
});

const state = (source: string, rid: string, file: string, uptime = "12.5"): string =>
  answer(`source=${source}\nrid=${rid}\nuptime=${uptime}\nfilename=${file}`, "\r\n");

test("19. state: direct, auto, fallback, unknown source, unknown fallback track, unreadable answers", async () => {
  const lib = new Map<string, Asset>();
  const a = makeAsset("/media/queue/a.mp3", 30, { title: "Hello", artist: "World" });
  lib.set(a.path, a);
  let reply = "";
  const { engine, timers, done } = await rig({ "pims.state": (c) => c.write(reply) }, { resolve: (p) => lib.get(p) });
  try {
    reply = state("direct", "", "");
    assert.deepEqual(await engine.state(), { source: "direct", current: null });

    reply = state("auto", "9", a.path);
    let s = await engine.state();
    assert.equal(s.source, "auto");
    assert.deepEqual({ ...s.current, startedAt: undefined }, { title: "Hello", artist: "World", assetId: a.id, path: a.path, startedAt: undefined });
    assert.equal(s.current?.startedAt, new Date(timers.now).toISOString(), "control clock, ISO 8601 UTC");
    const first = s.current?.startedAt;
    timers.advance(60_000);
    s = await engine.state();
    assert.equal(s.current?.startedAt, first, "same track: first observation kept");

    reply = state("fallback", "1", "/media/fallback/Some Song.v2.mp3");
    s = await engine.state();
    assert.equal(s.source, "fallback");
    assert.deepEqual({ t: s.current?.title, id: s.current?.assetId }, { t: "Some Song.v2", id: null }, "file name without extension");

    reply = state("stream", "", ""); // reserved to item 009, not accepted yet
    assert.equal((await engine.state()).source, "unknown");
    reply = state("banana", "1", a.path);
    assert.deepEqual(await engine.state(), { source: "unknown", current: null });
    for (const junk of [answer("Error: no such command"), answer(""), answer("source"), answer("source=auto\nrid=zz\nfilename=/media/a.mp3"),
      answer("source=auto\nrid=1\nfilename=relative.mp3"), answer("source=auto\nsource=direct\nrid=1\nfilename=/media/x\u0007.mp3")]) {
      reply = junk;
      const r = await engine.state();
      assert.equal(r.current, null);
      assert.ok(r.source === "unknown" || r.source === "auto");
    }
  } finally { await done(); }
});

test("19b. a duplicated key cannot forge the source (first occurrence wins)", async () => {
  const { engine, done } = await rig({ "pims.state": state("fallback", "1", "/media/f.mp3\nsource=direct") });
  try {
    assert.equal((await engine.state()).source, "fallback");
  } finally { await done(); }
});

test("20. skip: sent only when the source is auto", async () => {
  let source = "auto";
  const { server, engine, done } = await rig({
    "pims.state": (c) => c.write(state(source, "1", "/media/a.mp3")),
    "auto.skip": answer("Done."),
  });
  try {
    assert.deepEqual(await engine.skip(), { skipped: true });
    assert.deepEqual(server.lines, ["pims.state", "auto.skip"]);
    for (const s of ["direct", "fallback", "weird"]) {
      source = s;
      server.lines.length = 0;
      assert.deepEqual(await engine.skip(), { skipped: false });
      assert.deepEqual(server.lines, ["pims.state"], `no skip command for ${s}`);
    }
  } finally { await done(); }
});

test("20b. next() is the first waiting item, null when the queue is empty", async () => {
  const a = makeAsset("/media/n1.mp3", 40, { title: "One", artist: "Two" });
  let queue = "4 5";
  const { engine, done } = await rig({
    "auto.queue": (c) => c.write(answer(queue)),
    "request.metadata 4": meta(4, a.path),
    "request.metadata 5": meta(5, "/media/other.mp3"),
  }, { resolve: (p) => (p === a.path ? a : undefined) });
  try {
    assert.deepEqual(await engine.next(), { title: "One", artist: "Two", assetId: a.id, path: a.path, startedAt: null });
    queue = "";
    assert.equal(await engine.next(), null);
  } finally { await done(); }
});

test("21. healthy: true when answering, false within 2 s when mute, false when unreachable; one probe per 2 s; never rejects", async () => {
  const ok = await rig({ uptime: answer("0d 00h 00m 09s") });
  try {
    assert.equal(await ok.engine.healthy(), true);
    assert.equal(await ok.engine.healthy(), true);
    assert.equal(ok.server.lines.filter((l) => l === "uptime").length, 1, "two calls within 2 s: one probe");
    ok.timers.advance(2001);
    assert.equal(await ok.engine.healthy(), true);
    assert.equal(ok.server.lines.filter((l) => l === "uptime").length, 2);
    assert.equal(ok.engine.detail().connected, true);
    assert.equal(ok.engine.detail().lastOkAt, new Date(ok.timers.now).toISOString());
    assert.equal(ok.engine.detail().lastError, null);
  } finally { await ok.done(); }

  const mute = await rig({ uptime: () => undefined });
  try {
    const p = mute.engine.healthy();
    await until(() => mute.server.lines.length === 1, "probe sent");
    mute.timers.advance(2000);
    assert.equal(await p, false);
  } finally { await mute.done(); }

  const s = await FakeServer.start();
  const port = s.port;
  await s.stop();
  const dead = new LiquidsoapEngine({ host: "127.0.0.1", port, timers: new FakeTimers(), random: () => 0.5 });
  try {
    assert.equal(await dead.healthy(), false);
    assert.equal(dead.detail().connected, false);
    assert.equal(dead.detail().lastError, "unreachable");
    assert.equal(dead.detail().lastOkAt, null);
  } finally { await dead.close(); }
});

test("24. close() leaves no timer and no socket", async () => {
  const { server, engine, timers } = await rig({ uptime: answer("0d 00h 00m 01s") });
  await engine.healthy();
  await engine.close();
  assert.equal(timers.pending, 0);
  await until(() => server.sockets.size === 0, "socket closed");
  await until(() => server.lines.includes("exit"), "exit sent");
  await server.stop();
});

test("a push that times out says it may have been applied; the next read sees the real queue", async () => {
  const lib = new Map<string, Asset>();
  const a = makeAsset("/media/a.mp3", 30);
  lib.set(a.path, a);
  let mute = true;
  const { server, engine, timers, done } = await rig({
    "auto.push /media/a.mp3": () => undefined,
    "auto.queue": (c) => c.write(answer("8")),
    "request.metadata 8": meta(8, "/media/a.mp3"),
  }, { resolve: (p) => lib.get(p) });
  try {
    const p = engine.push(a).then(() => "ok", (e: EngineError) => e);
    await until(() => server.lines.length === 1, "push sent");
    timers.advance(3000);
    const e = await p;
    assert.ok(e instanceof EngineError && e.code === "timeout" && e.maybeApplied);
    assert.equal(server.lines.filter((l) => l.startsWith("auto.push")).length, 1, "never retried automatically");
    assert.equal((await reject(engine.queuedSeconds())).code, "unreachable", "down until the reconnection");
    mute = false;
    await until(() => timers.pending === 1, "reconnect planned");
    timers.advance(500);
    await until(() => engine.detail().connected, "reconnected");
    assert.equal(await engine.queuedSeconds(), 30, "the track that may have been applied is seen");
    assert.ok(!mute);
  } finally { await done(); }
});

test("startup does not wait for the engine: start() returns at once and a late engine is picked up", async () => {
  const s = await FakeServer.start();
  const port = s.port;
  await s.stop();
  const timers = new FakeTimers();
  const engine = new LiquidsoapEngine({ host: "127.0.0.1", port, timers, now: () => timers.now, random: () => 0.5, connectTimeoutMs: 777 });
  const back = new FakeServer();
  try {
    engine.start(); // returns immediately, does not throw
    await until(() => timers.pendingDelays().includes(500), "first retry planned");
    await back.listen(port);
    back.script = table({ uptime: answer("0d 00h 00m 01s") });
    timers.advance(500);
    await until(() => engine.detail().connected, "connected");
    assert.equal(await engine.healthy(), true);
  } finally {
    await engine.close();
    await back.stop();
    await turns(1);
  }
});
