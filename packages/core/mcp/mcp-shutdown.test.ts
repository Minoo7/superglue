import { setImmediate } from "node:timers/promises";
import Fastify from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { expect, it, vi } from "vitest";
import { mcpHandler, registerMcpShutdown, transports } from "./mcp-server.js";
import { registerHttpShutdown } from "../api/http-shutdown.js";

vi.mock("../auth/auth.js", () => ({ validateToken: vi.fn() }));
vi.mock("../utils/logs.js", () => ({ logMessage: vi.fn() }));
vi.mock("../utils/telemetry.js", () => ({ sessionId: "fixture", telemetryClient: null }));

it("should close idle MCP GET streams while preserving an active tool POST result", async () => {
  const server = Fastify();
  registerHttpShutdown(server);
  registerMcpShutdown(server);
  let started!: () => void;
  let finish!: () => void;
  const running = new Promise<void>((done) => {
    started = done;
  });
  const result = new Promise<void>((done) => {
    finish = done;
  });
  const mcp = new McpServer({ name: "shutdown-fixture", version: "1" });
  mcp.registerTool("blocked", { inputSchema: {} }, async () => {
    started();
    await result;
    return { content: [{ type: "text", text: "tool completed" }] };
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => "shutdown-fixture",
    onsessioninitialized: (id) => {
      transports[id] = transport;
    },
  });
  transport.onclose = () => {
    delete transports["shutdown-fixture"];
  };
  await mcp.connect(transport);
  transports["shutdown-fixture"] = transport;
  server.route({
    method: ["GET", "POST"],
    url: "/mcp",
    handler: async (request, reply) => {
      reply.hijack();
      await mcpHandler(Object.assign(request.raw, { body: request.body }), reply.raw);
    },
  });
  const url = await server.listen({ port: 0, host: "127.0.0.1" });
  const controller = new AbortController();
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-session-id": "shutdown-fixture",
  };
  try {
    const init = await fetch(`${url}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        },
      }),
    });
    expect(init.status).toBe(200);
    await init.text();
    const stream = await fetch(`${url}/mcp`, { headers, signal: controller.signal });
    expect(stream.status).toBe(200);
    const streamEnded = stream.text();
    const response = fetch(`${url}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "blocked", arguments: {} },
      }),
    }).then((r) => r.text());
    await running;
    const closed = vi.fn();
    const closing = server.close().then(closed);
    await streamEnded;
    await setImmediate();
    expect(closed).not.toHaveBeenCalled();
    finish();
    expect(await response).toContain("tool completed");
    await closing;
    expect(closed).toHaveBeenCalledOnce();
    expect(Object.keys(transports)).toEqual([]);
  } finally {
    finish();
    controller.abort();
    await transport.close();
    await server.close();
  }
}, 2500);

it("should reject an accepted GET that reaches MCP after shutdown starts", async () => {
  const server = Fastify();
  registerHttpShutdown(server);
  registerMcpShutdown(server);
  let accepted!: () => void;
  let continueRequest!: () => void;
  const started = new Promise<void>((done) => {
    accepted = done;
  });
  const gate = new Promise<void>((done) => {
    continueRequest = done;
  });
  server.get("/mcp", async (request, reply) => {
    accepted();
    await gate;
    reply.hijack();
    await mcpHandler(request.raw, reply.raw);
  });
  const url = await server.listen({ port: 0, host: "127.0.0.1" });
  try {
    const response = fetch(`${url}/mcp`);
    await started;
    const closing = server.close();
    await setImmediate();
    continueRequest();
    const rejected = await response;
    expect(rejected.status).toBe(503);
    await rejected.text();
    await closing;
  } finally {
    continueRequest();
    await server.close();
  }
}, 2500);
