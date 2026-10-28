import { Log } from "@superglue/shared";
import { PassThrough } from "stream";
import { logEmitter } from "../utils/logs.js";
import { registerApiModule } from "./registry.js";
import type { AuthenticatedFastifyRequest } from "./types.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const subscriptions = new Set<() => Promise<void>>();
let closingSubscriptions = false;

export function registerLogShutdown(server: FastifyInstance): void {
  closingSubscriptions = false;
  server.addHook("preClose", async () => {
    closingSubscriptions = true;
    await Promise.all([...subscriptions].map((close) => close()));
  });
}

async function logsStreamHandler(request: FastifyRequest, reply: FastifyReply) {
  if (closingSubscriptions) {
    return reply.code(503).send({ error: "Server is shutting down" });
  }
  const authReq = request as AuthenticatedFastifyRequest;
  const { traceId } = request.query as { traceId?: string };
  const orgId = authReq.authInfo.orgId;

  const stream = new PassThrough();

  const origin = request.headers.origin;

  reply
    .header("Content-Type", "text/event-stream")
    .header("Cache-Control", "no-cache")
    .header("Connection", "keep-alive")
    .header("X-Accel-Buffering", "no");

  if (origin) {
    reply
      .header("Access-Control-Allow-Origin", origin)
      .header("Access-Control-Allow-Credentials", "true");
  }

  reply.send(stream);

  stream.write(":ok\n\n");

  const onLog = (log: Log) => {
    if (log.orgId !== orgId) return;
    if (traceId && log.traceId !== traceId) return;
    if (!stream.destroyed) {
      stream.write(`data: ${JSON.stringify(log)}\n\n`);
    }
  };

  logEmitter.on("log", onLog);

  const cleanup = () => {
    logEmitter.removeListener("log", onLog);
    if (!stream.destroyed && !stream.writableEnded) stream.end();
  };

  const close = () =>
    new Promise<void>((resolve) => {
      if (reply.raw.closed) {
        cleanup();
        resolve();
        return;
      }
      const timeout = setTimeout(() => reply.raw.destroy(), 1000);
      reply.raw.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      reply.raw.shouldKeepAlive = false;
      cleanup();
    });
  subscriptions.add(close);
  reply.raw.once("close", () => {
    subscriptions.delete(close);
    cleanup();
  });

  request.raw.on("close", cleanup);
  request.raw.on("error", cleanup);
}

registerApiModule({
  name: "logs",
  routes: [
    {
      method: "GET",
      path: "/logs/stream",
      handler: logsStreamHandler,
      permissions: {
        type: "read",
        resource: "run",
        allowedBaseRoles: ["admin", "member", "enduser"],
      },
    },
  ],
});
