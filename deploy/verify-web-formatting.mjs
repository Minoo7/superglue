import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
const prettier = require("prettier/standalone");
const plugins = [require("prettier/plugins/babel"), require("prettier/plugins/estree")];
assert.equal(
  await prettier.format("const answer=42", { parser: "babel", plugins }),
  "const answer = 42;\n",
);
console.log("Production web formatting passed");
