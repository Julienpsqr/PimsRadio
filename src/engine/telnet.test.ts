// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EngineError } from "./engine.js";
import { renderCommand, TelnetLink, type Command } from "./telnet.js";
import { answer, FakeServer, FakeTimers, turns, until } from "./test-support.js";

const CONNECT_MS = 777; // unusual on purpose: easy to tell apart from reconnection delays

async function rig(script?: (line: string, c: import("./test-support.js").Conn) => void, over: Partial<ConstructorParameters<typeof TelnetLink>[0]> = {}) {
  const server = await FakeServer.start(script);
  const timers = new FakeTimers();
  const link = new TelnetLink({
    host: "127.0.0.1", port: server.port, timers, now: () => timers.now, random: () => 0.5,
    connectTimeoutMs: CONNECT_MS, ...over,
  });
  return { server, timers, link, done: async () => { await link.close(); await server.stop(); } };
}

const rejection = async (p: Promise<unknown>): Promise<EngineError> => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof EngineError, `expected EngineError, got ${String(e)}`);
    return e;
  }
  throw new Error("expected a rejection");
};

const probe: Command = { name: "uptime" };

test("2. an answer is rebuilt from fragments (mid-line, mid-END, CRLF) and only the exact END line ends it", async () => {
  const pieces = ["first li", "ne\r\nTHE EN", "D of the day\r\nEN", "D \r\nEN", "D\r", "\n"];
  const { server, link, done } = await rig((_l, c) => {
    void (async () => {
      for (const p of pieces) { c.write(p); await turns(5); }
    })();
  });
  try {
    const lines = await link.send(probe);
    assert.deepEqual(lines, ["first line", "THE END of the day", "END "]);
    assert.equal(server.lines.length, 1);
  } finally { await done(); }
});

test("3. commands are strictly serialised and each caller gets its own answer, in order", async () => {
  let outstanding = 0;
  let violations = 0;
  const { server, link, done } = await rig((line, c) => {
    if (++outstanding > 1) violations++;
    const rid = line.split(" ")[1];
    void turns(10).then(() => { outstanding--; c.write(answer(`rid="${rid}"`)); });
  });
  try {
    const results = await Promise.all([1, 2, 3, 4, 5].map((rid) => link.send({ name: "metadata", rid })));
    assert.deepEqual(results.map((r) => r[0]), [1, 2, 3, 4, 5].map((r) => `rid="${r}"`));
    assert.equal(violations, 0, "the server never saw a command before it had answered the previous one");
    assert.deepEqual(server.lines, [1, 2, 3, 4, 5].map((r) => `request.metadata ${r}`));
  } finally { await done(); }
});

test("4. the internal queue is bounded: the 65th outstanding command is rejected busy at once", async () => {
  const { link, server, done } = await rig(); // mute server
  try {
    const first = Array.from({ length: 64 }, (_, i) => link.send({ name: "metadata", rid: i }));
    const settled = first.map((p) => p.then(() => "ok", (e: EngineError) => e.code));
    const err = await rejection(link.send(probe));
    assert.equal(err.code, "busy");
    assert.equal(server.lines.length <= 1, true, "only one command is ever on the wire");
    await link.close();
    assert.ok((await Promise.all(settled)).every((c) => c === "disconnected"));
  } finally { await done(); }
});

test("5. a mute server: timeout at 3 s, socket destroyed, queued command rejected, reconnection planned", async () => {
  const { server, timers, link, done } = await rig();
  try {
    const a = link.send(probe).then(() => "ok", (e: EngineError) => e);
    const b = link.send(probe).then(() => "ok", (e: EngineError) => e);
    await until(() => server.lines.length === 1, "first command sent");
    timers.advance(2999);
    await turns(5);
    assert.equal(link.connected, true, "not yet");
    timers.advance(1);
    const [ea, eb] = await Promise.all([a, b]);
    assert.ok(ea instanceof EngineError && ea.code === "timeout");
    assert.ok(eb instanceof EngineError && eb.code === "disconnected");
    assert.equal(link.connected, false);
    await until(() => server.sockets.size === 0, "socket destroyed");
    assert.deepEqual(timers.pendingDelays(), [500], "reconnection is planned");
  } finally { await done(); }
});

test("6. a truncated answer rejects disconnected, and a write command says it may have been applied", async () => {
  const { link, done } = await rig((line, c) => {
    c.write(line.startsWith("auto.push") ? "7\n" : "5 6\n"); // no END, then the line drops
    c.destroy();
  });
  try {
    const read = await rejection(link.send({ name: "queue" }));
    assert.equal(read.code, "disconnected");
    assert.equal(read.maybeApplied, false);
    // wait for the automatic reconnection (manual time)
    const t = (link as unknown as { timers: FakeTimers }).timers;
    await until(() => t.pending === 1, "reconnect timer");
    t.advance(500);
    await until(() => link.connected, "reconnected");
    const write = await rejection(link.send({ name: "push", path: "/media/a.mp3" }));
    assert.equal(write.code, "disconnected");
    assert.equal(write.maybeApplied, true);
  } finally { await done(); }
});

test("7. a drop during a command rejects the running and the waiting ones, each exactly once", async () => {
  const { link, server, done } = await rig((_l, c) => c.destroy());
  try {
    const counts = [0, 0, 0];
    const codes: string[] = [];
    const ps = [0, 1, 2].map((i) => link.send(probe).then(
      () => { counts[i]!++; },
      (e: EngineError) => { counts[i]!++; codes.push(e.code); },
    ));
    await Promise.all(ps);
    await turns(20);
    assert.deepEqual(counts, [1, 1, 1]);
    assert.deepEqual(codes.sort(), ["disconnected", "disconnected", "disconnected"]);
    assert.equal(server.lines.length, 1, "the waiting commands were never sent");
  } finally { await done(); }
});

test("8. reconnection backoff: 0.5 s, 1 s, 2 s... capped at 15 s; success resets it; calls fail fast while down", async () => {
  const probeServer = await FakeServer.start();
  const port = probeServer.port;
  await probeServer.stop(); // now nothing listens on `port`
  const timers = new FakeTimers();
  const link = new TelnetLink({ host: "127.0.0.1", port, timers, now: () => timers.now, random: () => 0.5, connectTimeoutMs: CONNECT_MS });
  const server = new FakeServer();
  try {
    link.start();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      await until(() => timers.pendingDelays().some((d) => d !== CONNECT_MS) , `reconnect timer ${i}`);
      const d = timers.pendingDelays().find((x) => x !== CONNECT_MS)!;
      delays.push(d);
      assert.equal((await rejection(link.send(probe))).code, "unreachable", "fails at once while down");
      timers.advance(d);
    }
    assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);

    // The 8th attempt must have failed before the engine "comes back", or it would succeed.
    await until(() => timers.pendingDelays().some((d) => d !== CONNECT_MS), "next timer");
    await server.listen(port); // the engine comes back
    timers.advance(15000);
    await until(() => link.connected, "reconnected");
    server.script = (_l, c) => c.write(answer("ok"));
    assert.deepEqual(await link.send(probe), ["ok"]);

    server.dropClients(); // drops again: the backoff restarted from the beginning
    await until(() => !link.connected, "noticed the drop");
    await until(() => timers.pendingDelays().length > 0, "timer after drop");
    assert.deepEqual(timers.pendingDelays().filter((d) => d !== CONNECT_MS), [500]);
  } finally {
    await link.close();
    await server.stop();
  }
});

test("8b. backoff jitter stays within +/-20 % and uses the injected random", async () => {
  for (const [rnd, expected] of [[0, 400], [0.5, 500], [0.999, 600]] as const) {
    const free = await FakeServer.start();
    const port = free.port;
    await free.stop();
    const timers = new FakeTimers();
    const link = new TelnetLink({ host: "127.0.0.1", port, timers, random: () => rnd, connectTimeoutMs: CONNECT_MS });
    try {
      link.start();
      await until(() => timers.pendingDelays().some((d) => d !== CONNECT_MS), "timer");
      assert.equal(timers.pendingDelays().find((d) => d !== CONNECT_MS), expected);
    } finally { await link.close(); }
  }
});

test("9. no connection storm: 100 calls while down open no socket", async () => {
  const { server, link, timers, done } = await rig();
  try {
    link.start();
    await until(() => link.connected && server.connections === 1, "connected");
    server.dropClients();
    await until(() => !link.connected && timers.pending === 1, "down with a pending retry");
    const results = await Promise.all(Array.from({ length: 100 }, () => link.send(probe).then(() => "ok", (e: EngineError) => e.code)));
    assert.ok(results.every((c) => c === "unreachable"));
    await turns(30);
    assert.equal(server.connections, 1, "no extra connection");
  } finally { await done(); }
});

test("14. hostile answers (2 MiB without END, a 100 KiB line, invalid UTF-8) give protocol and a destroyed socket", async () => {
  const attacks: Array<[string, (c: import("./test-support.js").Conn) => void]> = [
    ["2 MiB of short lines, no END", (c) => { for (let i = 0; i < 1024; i++) c.write("x".repeat(2047) + "\n"); }],
    ["a 100 KiB line", (c) => c.write("y".repeat(100 * 1024) + "\n")],
    ["100 KiB without newline", (c) => c.write("z".repeat(100 * 1024))],
    ["invalid UTF-8", (c) => c.write(Buffer.from([0x61, 0xff, 0xfe, 0x0a]))],
  ];
  for (const [name, attack] of attacks) {
    const { server, link, done } = await rig((_l, c) => attack(c));
    try {
      const e = await rejection(link.send(probe));
      assert.equal(e.code, "protocol", name);
      await until(() => server.sockets.size === 0, `${name}: socket destroyed`);
      assert.equal(link.connected, false, name);
    } finally { await done(); }
  }
});

test("14b. unsolicited data when nothing was asked drops the link", async () => {
  let conn: import("./test-support.js").Conn | undefined;
  const { server, link, done } = await rig((_l, c) => { conn = c; c.write(answer("ok")); });
  try {
    await link.send(probe);
    conn!.write("surprise\n");
    await until(() => !link.connected, "dropped");
    await until(() => server.sockets.size === 0, "destroyed");
  } finally { await done(); }
});

test("the first call connects lazily; failing to connect rejects unreachable", async () => {
  const s = await FakeServer.start();
  const port = s.port;
  await s.stop();
  const timers = new FakeTimers();
  const link = new TelnetLink({ host: "127.0.0.1", port, timers, random: () => 0.5 });
  try {
    assert.equal((await rejection(link.send(probe))).code, "unreachable");
    assert.equal(link.lastError, "unreachable");
  } finally { await link.close(); }
});

test("a silent connect is abandoned after the connect timeout", async () => {
  // A listener whose backlog is never accepted is not portable; instead check the timer is armed
  // with the configured value and that firing it drops the connecting socket.
  const server = new net.Server();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  const timers = new FakeTimers();
  const link = new TelnetLink({ host: "127.0.0.1", port, timers, random: () => 0.5, connectTimeoutMs: 2000 });
  try {
    const p = link.send(probe).then(() => "ok", (e: EngineError) => e.code);
    assert.ok(timers.requested.includes(2000));
    timers.advance(2000);
    assert.equal(await p, "unreachable");
  } finally {
    await link.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("24. close(): says exit, destroys the socket, cancels every timer, rejects what is pending", async () => {
  const { server, timers, link, done } = await rig();
  try {
    const p = link.send(probe).then(() => "ok", (e: EngineError) => e.code);
    await until(() => server.lines.length === 1, "sent");
    const closing = link.close();
    assert.equal(await p, "disconnected");
    await closing;
    assert.equal(timers.pending, 0, "no timer left");
    await until(() => server.sockets.size === 0, "socket closed");
    assert.equal((await rejection(link.send(probe))).code, "disconnected");
    await link.close(); // idempotent
  } finally { await done(); }
});

test("24b. close() of an idle healthy link sends exit", async () => {
  const { server, link, timers, done } = await rig((_l, c) => c.write(answer("ok")));
  try {
    await link.send(probe);
    await link.close();
    await until(() => server.lines.includes("exit"), "exit received");
    assert.equal(timers.pending, 0);
  } finally { await done(); }
});

test("the command whitelist builds exactly these lines and nothing else", () => {
  assert.equal(renderCommand({ name: "push", path: "/media/a.mp3" }), "auto.push /media/a.mp3");
  assert.equal(renderCommand({ name: "queue" }), "auto.queue");
  assert.equal(renderCommand({ name: "metadata", rid: 12 }), "request.metadata 12");
  assert.equal(renderCommand({ name: "skip" }), "auto.skip");
  assert.equal(renderCommand({ name: "uptime" }), "uptime");
  assert.equal(renderCommand({ name: "state" }), "pims.state");
  for (const rid of [-1, 1.5, NaN, 1e12]) assert.throws(() => renderCommand({ name: "metadata", rid }), EngineError);
  assert.throws(() => renderCommand({ name: "shutdown" } as unknown as Command));
});
