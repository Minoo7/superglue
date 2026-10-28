import { setImmediate } from "node:timers/promises";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { registerLogShutdown } from "./logs.js";
import { registerAllRoutes } from "./registry.js";
import { registerHttpShutdown } from "./http-shutdown.js";
import { logEmitter } from "../utils/logs.js";

it("should finish dashboard log subscriptions and remove listeners during shutdown", async () => {
  const server = Fastify();
  registerHttpShutdown(server);
  registerLogShutdown(server);
  server.addHook("onRequest", async (request) => {
    Object.assign(request, { authInfo: { orgId: "fixture" } });
  });
  await registerAllRoutes(server);
  let finish!: () => void;
  let started!: () => void;
  const running = new Promise<void>((done) => {
    started = done;
  });
  const work = new Promise<void>((done) => {
    finish = done;
  });
  server.post("/work", async () => {
    started();
    await work;
    return { completed: true };
  });
  const url = await server.listen({ port: 0, host: "127.0.0.1" });
  const controller = new AbortController();
  const before = logEmitter.listenerCount("log");
  try {
    const stream = await fetch(`${url}/v1/logs/stream`, { signal: controller.signal });
    expect(stream.status).toBe(200);
    expect(logEmitter.listenerCount("log")).toBe(before + 1);
    const ended = stream.text();
    const response = fetch(`${url}/work`, { method: "POST" }).then((r) => r.json());
    await running;
    let closed = false;
    const closing = server.close().then(() => {
      closed = true;
    });
    expect(await ended).toContain(":ok");
    await setImmediate();
    expect(closed).toBe(false);
    finish();
    expect(await response).toEqual({ completed: true });
    await closing;
    expect(logEmitter.listenerCount("log")).toBe(before);
  } finally {
    finish();
    controller.abort();
    await server.close();
  }
}, 2500);
