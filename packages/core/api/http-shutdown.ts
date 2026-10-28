import type { FastifyInstance } from "fastify";

export function registerHttpShutdown(server: FastifyInstance): void {
  let closing = false;
  server.addHook("preClose", async () => {
    closing = true;
  });
  server.addHook("onResponse", async () => {
    if (closing) server.server.closeIdleConnections();
  });
}
