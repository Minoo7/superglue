import { setTimeout as delay } from "node:timers/promises";
import { startApiServer } from "./api/api-server.js";
import { bootstrapOss } from "./bootstrap/oss-bootstrap.js";
import { createDataStore } from "./datastore/datastore.js";
import { validateEnvironment } from "./shared/environment.js";
import { shutdownSharedHtmlMarkdownPool } from "./utils/html-markdown-pool.js";
import { logMessage } from "./utils/logs.js";
import { initializeWorkerPools } from "./worker/worker-pool-registry.js";

async function startServer() {
  validateEnvironment();

  const datastore = await createDataStore({ type: "postgres" });
  await bootstrapOss(datastore);

  const workerPools = initializeWorkerPools(datastore);
  const server = await startApiServer(datastore, workerPools);
  let shutdown: Promise<void> | undefined;
  const stop = () => {
    shutdown ??= (async () => {
      logMessage("info", "SIGTERM received; draining application");
      const deadline = setTimeout(() => process.exit(1), 14_390_000);
      deadline.unref();
      await server.close();
      while (
        workerPools.toolExecution.getStats().busyWorkers ||
        workerPools.toolExecution.getStats().queueSize
      ) {
        await delay(100);
      }
      await workerPools.toolExecution.shutdown();
      await shutdownSharedHtmlMarkdownPool();
      await datastore.disconnect();
      logMessage("info", "Shutdown complete");
      process.exit(0);
    })();
    shutdown.catch((error) => {
      logMessage("error", `Shutdown failed: ${String(error)}`);
      process.exit(1);
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
