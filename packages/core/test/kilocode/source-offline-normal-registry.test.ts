import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NativeProcess } from "../../src/kilocode/process-host"
import { assertImage, withImage } from "../../src/kilocode/source-offline"

function acl(file: string) {
  const child = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-Acl -LiteralPath '${file.replaceAll("'", "''")}').Sddl`],
    {
      windowsHide: true,
      encoding: "utf8",
      env: {
        ...process.env,
        PSModulePath: path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "Modules"),
      },
    },
  )
  if (child.status !== 0) throw new Error("Synthetic control branch ACL observation failed")
  return child.stdout.trim()
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-normal-registry-"))
  const home = path.join(root, "home")
  const local = path.join(home, "AppData", "Local")
  await mkdir(local, { recursive: true })
  const sibling = path.join(home, "unrelated.bin")
  await writeFile(sibling, "SYNTHETIC_EXCLUDED_BYTES")
  const executable = await realpath(process.env.RAYA_OFFLINE_TEST_HELPER ?? (await NativeProcess.source()))
  const digest = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex")
  const file = path.join(home, ".kilocode")
  return {
    root,
    home,
    local,
    sibling,
    helper: { executable, digest },
    roots: [{ kind: "json" as const, path: file }],
    policy: { version: 1 as const, directories: [file], files: [] },
    registry: path.join(local, "Raya", "offline-recovery"),
  }
}

for (const failure of [false, true])
  test.skipIf(process.platform !== "win32")(
    `normal LOCALAPPDATA recovery holds only negative parent metadata and joins callback ${failure ? "failure" : "success"}`,
    async () => {
      const cfg = await fixture()
      const original = [cfg.home, path.join(cfg.home, "AppData"), cfg.local].map(acl)
      const primary = new Error("Synthetic callback failure")
      const run = withImage(cfg, async (image) => {
        const value = assertImage(image, cfg.roots)
        expect(value.files).toEqual([])
        expect(await readdir(value.roots[0].staged)).toEqual([])
        for (const dir of [cfg.home, path.join(cfg.home, "AppData"), cfg.local, cfg.registry])
          await assert.rejects(rename(dir, `${dir}-moved`))
        await assert.rejects(mkdir(cfg.roots[0].path))
        expect(await readFile(cfg.sibling, "utf8")).toBe("SYNTHETIC_EXCLUDED_BYTES")
        expect([path.join(cfg.home, "AppData"), cfg.local].map(acl)).toEqual(original.slice(1))
        if (failure) throw primary
      })
      if (failure)
        await assert.rejects(run, (err: unknown) => err instanceof AggregateError && err.errors.includes(primary))
      if (!failure) await run
      expect([cfg.home, path.join(cfg.home, "AppData"), cfg.local].map(acl)).toEqual(original)
      await mkdir(cfg.roots[0].path)
      await rename(cfg.local, `${cfg.local}-moved`)
      expect(await readFile(cfg.sibling, "utf8")).toBe("SYNTHETIC_EXCLUDED_BYTES")
    },
    30000,
  )

test.skipIf(process.platform !== "win32")(
  "negative control exception refuses missing branch and logical or positive overlap",
  async () => {
    for (const kind of ["branch", "logical", "positive"] as const) {
      const cfg = await fixture()
      const registry =
        kind === "branch"
          ? path.join(cfg.home, "unknown", "recovery")
          : kind === "logical"
            ? path.join(cfg.roots[0].path, "recovery")
            : cfg.registry
      const roots = kind === "positive" ? [{ kind: "json" as const, path: cfg.home }] : cfg.roots
      const policy = kind === "positive" ? { version: 1 as const, directories: [cfg.home], files: [] } : cfg.policy
      await assert.rejects(
        withImage({ ...cfg, roots, policy, registry }, async () => {
          throw new Error("Forbidden callback")
        }),
      )
      expect(await readdir(cfg.home)).toEqual(["AppData", "unrelated.bin"])
    }
  },
)

for (const mode of ["disappear", "replace"])
  test.skipIf(process.platform !== "win32")(
    `actual pre-acquisition control branch ${mode} refuses without recreating the known branch`,
    async () => {
      const cfg = await fixture()
      const script = `const fs=require('node:fs');const path=require('node:path');const [dir,root,mode]=process.argv.slice(1);const timer=setTimeout(()=>{watch.close();process.exitCode=2},5000);const watch=fs.watch(dir,(_,name)=>{if(name!=='Raya')return;watch.close();clearTimeout(timer);try{fs.renameSync(dir,dir+'-moved');if(mode==='replace')fs.mkdirSync(dir);fs.writeFileSync(path.join(root,'changed'),mode)}catch(err){console.error(err.code);process.exitCode=3}});fs.writeFileSync(path.join(root,'ready'),'ready')`
      const child = Bun.spawn([process.execPath, "-e", script, cfg.local, cfg.root, mode], {
        windowsHide: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
      try {
        const deadline = Date.now() + 5000
        while (
          !(await access(path.join(cfg.root, "ready")).then(
            () => true,
            () => false,
          ))
        ) {
          if (Date.now() > deadline || child.exitCode !== null)
            throw new Error("Actual branch watcher failed before readiness")
          await Bun.sleep(10)
        }
        let called = false
        await assert.rejects(
          withImage(cfg, async () => {
            called = true
          }),
          (err: unknown) =>
            err instanceof Error &&
            (("code" in err && err.code === "ENOENT") ||
              err.message.includes("branch changed") ||
              err.message.includes("Offline canonical path unavailable")),
        )
        const [code, , stderr] = await Promise.all([child.exited, ...output])
        expect(code, `Retained ${cfg.root}: ${stderr}`).toBe(0)
        expect(called).toBeFalse()
        expect(await readFile(path.join(cfg.root, "changed"), "utf8")).toBe(mode)
        if (mode === "disappear") await assert.rejects(access(cfg.local))
        if (mode === "replace") expect(await readdir(cfg.local)).toEqual([])
        expect(await readdir(`${cfg.local}-moved`)).toEqual(["Raya"])
        expect(await readFile(cfg.sibling, "utf8")).toBe("SYNTHETIC_EXCLUDED_BYTES")
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
        await Promise.all(output)
      }
    },
    15000,
  )
