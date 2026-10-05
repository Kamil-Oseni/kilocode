import { expect, test } from "bun:test"
import { build, type BuildOptions } from "esbuild"
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const load = createRequire(import.meta.url)
const config = load(path.join(root, "esbuild.js")) as { getExtensionConfig: () => BuildOptions }

test("the standalone extension bundle retains strict Memory parsing under Node", async () => {
  const parent = path.resolve(tmpdir())
  const dir = await mkdtemp(path.join(parent, "raya-parser-bundle-"))
  const file = path.join(dir, "parser.cjs")
  try {
    await build({
      ...config.getExtensionConfig(),
      absWorkingDir: root,
      entryPoints: ["src/second-brain/control/frames.ts"],
      outfile: file,
      minifySyntax: true,
      minifyWhitespace: true,
      sourcemap: false,
    })
    const child = Bun.spawnSync(
      [
        "node",
        "-e",
        `const assert = require("node:assert/strict");
const parser = require(process.argv[1]);
const text = '{"z":"caf\\u00e9 \\u65e5\\u672c\\u8a9e \\ud83d\\ude00","n":1791036803915000001}\\n';
const value = parser.decode(Buffer.from(text));
assert.equal(value.value.z, "caf\\u00e9 \\u65e5\\u672c\\u8a9e \\ud83d\\ude00");
assert.equal(parser.canonical(value.tree, value.text), '{"n":1791036803915000001,"z":"caf\\u00e9 \\u65e5\\u672c\\u8a9e \\ud83d\\ude00"}');
for (const text of ['{"n":1,"n":2}\\n', '{"n":1,}\\n', '{/*comment*/"n":1}\\n', '{"n":1e999}\\n']) assert.throws(() => parser.decode(Buffer.from(text)));
assert.throws(() => parser.decode(Buffer.from([123,34,110,34,58,34,255,34,125,10])));`,
        file,
      ],
      { windowsHide: true },
    )
    expect(child.stderr.toString()).toBe("")
    expect(child.exitCode).toBe(0)
  } finally {
    if (path.dirname(path.resolve(dir)) !== parent) throw new Error("Unexpected temporary bundle path")
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)
