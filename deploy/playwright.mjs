import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

export function playwrightPackages() {
  const packages = new Map();
  for (const location of ["package.json", "packages/core/package.json"]) {
    const require = createRequire(resolve(location));
    const manifest = require.resolve("playwright/package.json");
    const metadata = JSON.parse(readFileSync(manifest, "utf8"));
    packages.set(metadata.version, {
      version: metadata.version,
      directory: dirname(manifest),
      playwright: require("playwright"),
    });
  }
  return [...packages.values()];
}

if (process.argv[2] === "install") {
  for (const { version, directory } of playwrightPackages()) {
    console.log(`Installing production Playwright ${version}`);
    const result = spawnSync(
      process.execPath,
      [resolve(directory, "cli.js"), "install", "--with-deps", "chromium"],
      { stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
