import { expect, test } from "bun:test"
import path from "node:path"
import z from "zod"
import { tmpdir } from "../fixture/fixture"
for (const mode of [
  "scaffold",
  "scaffold-order",
  "scaffold-foreign",
  "scaffold-rebind",
  "project",
  "parent",
  "file",
  "rebind",
  "unset",
  "foreign",
  "dangling",
])
  test(`actual project config ${mode} admission and lineage`, async () => {
    await using tmp = await tmpdir()
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/project-config-admission.ts"),
        tmp.path,
        mode,
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const timer = setTimeout(() => child.kill(), 20000)
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer))
    expect(code, `${tmp.path}: ${err}`).toBe(0)
    const receipt = z
      .object({ mode: z.string(), passed: z.literal(true), results: z.array(z.string()) })
      .parse(JSON.parse(out.trim().split(/\r?\n/).at(-1) ?? "null"))
    expect(receipt.mode).toBe(mode)
    expect(receipt.results.length).toBeGreaterThan(1)
    console.log(JSON.stringify(receipt))
  }, 25000)
