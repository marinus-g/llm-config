import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDirectory = join(root, "plugin");

test("server plugin directory contains only plugin entrypoint exports", async () => {
  const files = (await readdir(pluginDirectory))
    .filter((file) => extname(file) === ".js")
    .sort();

  assert.equal(files.some((file) => file.endsWith(".test.js")), false);

  for (const file of files) {
    const source = await readFile(join(pluginDirectory, file), "utf8");
    const named = [...source.matchAll(/^export\s+(?:const|let|var|function|async\s+function|class)\s+(\w+)/gm)]
      .map((match) => match[1]);
    assert.ok(named.includes("server") || /^export\s+default\s+/m.test(source),
      `${file} must export a plugin entrypoint`);
    assert.deepEqual(named.filter((name) => name !== "server"), [],
      `${file} must not export helper symbols from the auto-loaded plugin directory`);
  }
});
