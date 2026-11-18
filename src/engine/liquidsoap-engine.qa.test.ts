// SPDX-License-Identifier: AGPL-3.0-or-later
// QA tests for item 001 (added after manual mutations showed these behaviours were not pinned
// by the developer's tests). Only tests: nothing here changes product code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { type Asset } from "../library/library.js";
import { EngineError } from "./engine.js";
import { LiquidsoapEngine, type LiquidsoapEngineOptions } from "./liquidsoap-engine.js";
import { TelnetLink } from "./telnet.js";
import { answer, type Conn, FakeServer, FakeTimers, makeAsset, turns, until } from "./test-support.js";

type Script = (line: string, c: Conn) => void;

async function linkRig(script?: Script) {
  const server = await FakeServer.start(script);
  const timers = new FakeTimers();
  const link = new TelnetLink({ host: "127.0.0.1", port: server.port, timers, now: () => timers.now, random: () => 0.5 });
  return { server, timers, link, done: async () => { await link.close(); await server.stop(); } };
}

async function engineRig(script: Script, over: Partial<LiquidsoapEngineOptions> = {}) {
  const server = await FakeServer.start(script);
  const timers = new FakeTimers();
  const engine = new LiquidsoapEngine({
    host: "127.0.0.1", port: server.port, timers, now: () => timers.now, random: () => 0.5, mediaRoot: "/media", ...over,
  });
  return { server, timers, engine, done: async () => { await engine.close(); await server.stop(); } };
}

const reject = async (p: Promise<unknown>): Promise<EngineError> => {
  try { await p; } catch (e) { assert.ok(e instanceof EngineError, String(e)); return e; }
  throw new Error("expected a rejection");
};

test("QA 3b. serialisation holds on an ESTABLISHED connection (the server never sees two commands at once)", async () => {
  // Mutation found: without the 'one in flight' guard the developer's test 3 still passed because
  // the first burst is queued while the link is still connecting. Warm the link up first.
  let outstanding = 0;
  let violations = 0;
  const { server, link, done } = await linkRig((line, c) => {
    if (++outstanding > 1) violations++;
    const rid = line.split(" ")[1];
    void turns(10).then(() => { outstanding--; c.write(answer(line === "uptime" ? "ok" : `rid="${rid}"`)); });
  });
  try {
    await link.send({ name: "uptime" });
    assert.ok(link.connected);
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((rid) => link.send({ name: "metadata", rid })));
    assert.deepEqual(results.map((r) => r[0]), [1, 2, 3, 4, 5, 6].map((r) => `rid="${r}"`));
    assert.equal(violations, 0);
    assert.equal(server.connections, 1);
  } finally { await done(); }
});

test("QA 14c. bytes after END (two answers concatenated, END in the middle) never become a second answer: link dropped", async () => {
  const { server, link, timers, done } = await linkRig((_l, c) => c.write("7\nEND\n8\nEND\n"));
  try {
    const first = await link.send({ name: "uptime" });
    assert.deepEqual(first, ["7"]);
    await until(() => !link.connected, "link dropped after the surplus");
    await until(() => server.sockets.size === 0, "socket destroyed");
    assert.equal(timers.pending, 1, "a reconnection is planned");
    // a command sent now fails fast, it does not receive the stray '8'
    assert.equal((await reject(link.send({ name: "uptime" }))).code, "unreachable");
  } finally { await done(); }
});

test("QA 14d. a response that drips one byte at a time is rebuilt correctly while inside the timeout", async () => {
  const { link, done } = await linkRig((_l, c) => {
    void (async () => { for (const ch of "5 6 7\r\nEND\r\n") { c.write(ch); await turns(2); } })();
  });
  try {
    assert.deepEqual(await link.send({ name: "queue" }), ["5 6 7"]);
  } finally { await done(); }
});

test("QA 14e. a drip that never reaches END times out (timeout, maybeApplied for a write) and the socket is destroyed", async () => {
  const { server, link, timers, done } = await linkRig((_l, c) => c.write("7\n"));
  try {
    const p = link.send({ name: "push", path: "/media/a.mp3" });
    await until(() => server.lines.length === 1, "sent");
    await turns(20);
    timers.advance(3000);
    const e = await reject(p);
    assert.equal(e.code, "timeout");
    assert.equal(e.maybeApplied, true);
    await until(() => server.sockets.size === 0, "socket destroyed");
  } finally { await done(); }
});

test("QA 20c. skip: an ERROR answer to auto.skip is not reported as a success (protocol, maybeApplied)", async () => {
  // Mutation found: replacing the ERROR check by a never-matching one left every test green.
  const { engine, done } = await engineRig((line, c) => {
    if (line === "pims.state") c.write(answer("source=auto\nrid=1\nuptime=3.0\nfilename=/media/a.mp3", "\r\n"));
    else c.write(answer("ERROR: unknown command"));
  });
  try {
    const e = await reject(engine.skip());
    assert.equal(e.code, "protocol");
    assert.equal(e.maybeApplied, true);
  } finally { await done(); }
});

test("QA 15b. push answered with two lines, a RID with garbage or a negative number is a protocol error, nothing booked", async () => {
  for (const body of ["7\n8", "7 ", "-1", "7;exit", "1e3", "1234567890", "0x1"]) {
    let sent = 0;
    const { server, engine, done } = await engineRig((line, c) => {
      if (line.startsWith("auto.push")) { sent++; c.write(answer(body)); } else if (line === "auto.queue") c.write(answer("7"));
      else c.write(answer(""));
    });
    try {
      const e = await reject(engine.push(makeAsset("/media/a.mp3", 10)));
      assert.equal(e.code, "protocol", JSON.stringify(body));
      assert.equal(sent, 1);
      assert.ok(server.lines.every((l) => l.startsWith("auto.push")));
    } finally { await done(); }
  }
});

test("QA 18b. a reconnection empties the RID ledger (RIDs restart from zero with a new engine process)", async () => {
  // Mutation found: removing the ledger reset in the connect hook left every test green.
  const a = makeAsset("/media/a.mp3", 30);
  const b = makeAsset("/media/b.mp3", 45);
  const lib = new Map<string, Asset>([[a.path, a], [b.path, b]]);
  let generation = 1;
  const { server, engine, timers, done } = await engineRig((line, c) => {
    if (line === "auto.push /media/a.mp3") c.write(answer("0"));
    else if (line === "auto.queue") c.write(answer("0"));
    else if (line === "request.metadata 0") {
      const f = generation === 1 ? "/media/a.mp3" : "/media/b.mp3";
      c.write(answer(`initial_uri="${f}"\nrid="0"`));
    } else c.write(answer("ERROR"));
  }, { resolve: (p) => lib.get(p) });
  try {
    await engine.push(a);
    assert.equal(await engine.queuedSeconds(), 30, "booked at push time");
    // the engine restarts: the connection drops, RID 0 now belongs to another track
    generation = 2;
    server.dropClients();
    await until(() => timers.pending === 1, "reconnect planned");
    timers.advance(500);
    await until(() => engine.detail().connected, "reconnected");
    assert.equal(await engine.queuedSeconds(), 45, "RID 0 is the new engine's track, not the stale booked one");
  } finally { await done(); }
});

test("QA 9b. 100 simultaneous push/queue/state calls: 64 outstanding at most, the surplus is busy at once, every promise settles exactly once", async () => {
  const lib = new Map<string, Asset>();
  const assets = Array.from({ length: 100 }, (_, i) => { const a = makeAsset(`/media/${i}.mp3`, 10); lib.set(a.path, a); return a; });
  let n = 0;
  const { server, engine, done } = await engineRig((line, c) => {
    if (line.startsWith("auto.push")) void turns(3).then(() => c.write(answer(String(n++))));
    else if (line === "pims.state") void turns(3).then(() => c.write(answer("source=auto\nrid=1\nuptime=1.0\nfilename=/media/0.mp3")));
    else void turns(3).then(() => c.write(answer("")));
  }, { resolve: (p) => lib.get(p) });
  try {
    await engine.healthy(); // connection established first: every call below is really concurrent
    const settled: string[] = [];
    const calls = assets.map((a, i) => {
      const op = i % 3 === 0 ? engine.state() : i % 3 === 1 ? engine.queuedSeconds() : engine.push(a);
      return op.then(() => { settled.push("ok"); return "ok"; }, (e: EngineError) => { settled.push(e.code); return e.code; });
    });
    const res = await Promise.all(calls);
    assert.equal(settled.length, 100);
    const busy = res.filter((r) => r === "busy").length;
    assert.ok(res.every((r) => r === "ok" || r === "busy"), JSON.stringify([...new Set(res)]));
    assert.ok(busy > 0, "more than 64 distinct commands were asked: some were refused");
    assert.ok(server.lines.length <= 65, "never more than 64 commands accepted at once, plus the probe");
    // after the burst the link is healthy and answers again
    assert.equal(await engine.healthy(), true);
  } finally { await done(); }
});

test("QA 19c. hostile values in the pims.state answer: control characters, forged keys and absurd sizes never produce a current track", async () => {
  const hostile = [
    "/media/a.mp3 source=direct", "/media/a\rsource=direct.mp3", "/media/../etc/passwd", "relative.mp3",
    "annotate:x=\"y\":/media/a.mp3", "/media/" + "a".repeat(5000), "/media/a\u0000.mp3",
  ];
  for (const file of hostile) {
    const { engine, done } = await engineRig((_l, c) => c.write(answer(`source=auto\nrid=1\nuptime=1.0\nfilename=${file}`, "\n")));
    try {
      const s = await engine.state();
      assert.equal(s.source, "auto", JSON.stringify(file.slice(0, 40)));
      assert.equal(s.current, null, `unsafe filename refused: ${JSON.stringify(file.slice(0, 40))}`);
    } finally { await done(); }
  }
  // a forged key in the file name stays inside the value: first occurrence of the key wins
  const { engine, done } = await engineRig((_l, c) => c.write(answer("source=auto\nrid=1\nfilename=/media/x.mp3\nsource=direct")));
  try {
    assert.equal((await engine.state()).source, "auto");
  } finally { await done(); }
});

test("QA 19d. a non-numeric rid, an overlong rid, or no rid line do not crash state()", async () => {
  for (const rid of ["abc", "1".repeat(50), "-3"]) {
    const { engine, done } = await engineRig((_l, c) => c.write(answer(`source=auto\nrid=${rid}\nfilename=/media/a.mp3`)));
    try {
      assert.equal((await engine.state()).current, null, rid.slice(0, 10));
    } finally { await done(); }
  }
});

test("QA 21b. healthy() never rejects even when the library resolver throws and the server sends garbage", async () => {
  const { server, engine, timers, done } = await engineRig((_l, c) => c.write("\u0000\u0001garbage without newline"), {
    resolve: () => { throw new Error("db closed"); },
  });
  try {
    const p = engine.healthy();
    await until(() => server.lines.length === 1, "probe sent");
    await turns(20);
    timers.advance(2000); // the probe's own 2 s limit
    assert.equal(await p, false);
    assert.equal(engine.detail().lastError === null, false);
  } finally { await done(); }
});

test("QA 2b. a CR alone inside a line is kept as data (not a line break), END must be the whole line", async () => {
  const { link, done } = await linkRig((_l, c) => c.write("a\rEND\nEND\n"));
  try {
    assert.deepEqual(await link.send({ name: "queue" }), ["a\rEND"]);
  } finally { await done(); }
});

test("QA 24c. close() while commands are queued and in flight settles all of them with 'disconnected' and leaves nothing pending", async () => {
  const { server, link, timers, done } = await linkRig(() => undefined); // mute server
  try {
    const ps = [1, 2, 3].map((rid) => link.send({ name: "metadata", rid }).then(() => "ok", (e: EngineError) => e.code));
    await until(() => server.lines.length === 1, "first command sent");
    await link.close();
    assert.deepEqual(await Promise.all(ps), ["disconnected", "disconnected", "disconnected"]);
    assert.equal(timers.pending, 0);
    assert.equal((await reject(link.send({ name: "uptime" }))).code, "disconnected");
  } finally { await done(); }
});

test("QA 4b. exactly 64 of 100 simultaneous commands on an established link are answered, 36 are busy, each caller gets its own answer", async () => {
  const { server, link, done } = await linkRig((line, c) => {
    const rid = line.split(" ")[1];
    void turns(2).then(() => c.write(answer(line === "uptime" ? "ok" : `rid="${rid}"`)));
  });
  try {
    await link.send({ name: "uptime" });
    const res = await Promise.all(
      Array.from({ length: 100 }, (_, rid) => link.send({ name: "metadata", rid }).then((l) => `${rid}:${l[0]}`, (e: EngineError) => `${rid}:${e.code}`)),
    );
    const ok = res.filter((r) => !r.endsWith(":busy"));
    assert.equal(ok.length, 64);
    for (const r of ok) { const [rid] = r.split(":"); assert.equal(r, `${rid}:rid="${rid}"`); }
    assert.deepEqual(res.slice(64).every((r) => r.endsWith(":busy")), true, "the first 64 are accepted, the rest refused");
    assert.equal(server.lines.length, 65);
    assert.equal((await link.send({ name: "metadata", rid: 1 }))[0], 'rid="1"', "the link still works afterwards");
  } finally { await done(); }
});
