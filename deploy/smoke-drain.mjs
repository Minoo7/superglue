import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const server = createServer((_request, response) => {
  writeFileSync("/tmp/release-deno-inflight", "started");
  response.end("ok");
});
await new Promise((done) => server.listen(39001, "127.0.0.1", done));
try {
  const response = await fetch("http://127.0.0.1:3002/v1/tools/run", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      tool: {
        id: "release-drain",
        steps: [
          {
            id: "delayed",
            config: {
              type: "transform",
              transformCode:
                '() => fetch("http://127.0.0.1:39001/started").then(() => new Promise(resolve => setTimeout(resolve, 5000))).then(() => ({ drained: true }))',
            },
          },
        ],
      },
      payload: {},
    }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.drained, true, JSON.stringify(result));
  console.log("In-flight Deno request completed during SIGTERM");
} finally {
  await new Promise((done) => server.close(done));
}
