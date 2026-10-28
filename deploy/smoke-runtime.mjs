import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { playwrightPackages } from "./playwright.mjs";

assert.equal(process.arch, "arm64");
const require = createRequire(resolve("packages/core/package.json"));
const { createCanvas } = require("@napi-rs/canvas");
const canvas = createCanvas(24, 24);
canvas.getContext("2d").fillRect(0, 0, 24, 24);
const sharp = require("sharp");
const converted = await sharp(canvas.toBuffer("image/png")).webp().toBuffer();
assert(converted.length > 0);
assert.match(execFileSync("deno", ["eval", "console.log(6*7)"], { encoding: "utf8" }), /42/);
const server = createServer((_request, response) =>
  response.end("<title>Native browser fixture</title>"),
);
await new Promise((done) => server.listen(0, "127.0.0.1", done));
try {
  for (const { version, playwright } of playwrightPackages()) {
    const browser = await playwright.chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      assert.equal(await page.title(), "Native browser fixture");
      console.log(`Chromium launched for production Playwright ${version}`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((done) => server.close(done));
}

const api = "http://127.0.0.1:3002/v1";
const headers = {
  authorization: `Bearer ${process.env.AUTH_TOKEN}`,
  "content-type": "application/json",
};
assert.equal((await fetch(`${api}/tools`)).status, 401);
assert.equal((await fetch(`${api}/tools`, { headers })).status, 200);
assert.equal((await fetch("http://127.0.0.1:3001")).status, 200);
const response = await fetch(`${api}/tools/run`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    tool: {
      id: "release-smoke",
      name: "Release smoke",
      steps: [
        {
          id: "answer",
          config: { type: "transform", transformCode: "(input) => ({ answer: input.value * 2 })" },
        },
      ],
    },
    payload: { value: 21 },
  }),
});
const result = await response.json();
assert.equal(response.status, 200, JSON.stringify(result));
assert.equal(result.success, true, JSON.stringify(result));
assert.equal(result.data.answer, 42, JSON.stringify(result));
const { Client } = require("minio");
const minio = new Client({
  endPoint: "storage",
  port: 9000,
  useSSL: false,
  accessKey: process.env.MINIO_ROOT_USER,
  secretKey: process.env.MINIO_ROOT_PASSWORD,
});
if (!(await minio.bucketExists(process.env.MINIO_BUCKET_NAME)))
  await minio.makeBucket(process.env.MINIO_BUCKET_NAME);
const { S3FileService } = await import("../packages/core/dist/filestore/s3-file-service.js");
const files = S3FileService.createForMinIO();
const uri = `s3://${process.env.MINIO_BUCKET_NAME}/default/raw/release-smoke.txt`;
await files.uploadFile(uri, "release fixture", { orgId: "" });
assert.equal((await files.downloadFile(uri, { orgId: "" })).toString(), "release fixture");
console.log(
  "Canvas, sharp, Deno, browser, auth, web, API tool and application S3 roundtrip passed",
);
process.exit(0);
