import { expect, test } from "bun:test"
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { preparation } from "../../src/kilocode/source-offline-frame"
import { withImage, assertImage } from "../../src/kilocode/source-offline"

test.skipIf(process.platform !== "win32")(
  "actual native immutable stage diagnoses sharing, missing and access refusal without widening admission",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-offline-stage-"))
    const output = path.join(root, "stage.exe")
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      LOCALAPPDATA: path.join(root, "local"),
      KILO_TEST_HOME: root,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
    }
    const compiler = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(import.meta.dir, "fixtures/source-offline-stage.ps1"),
        "-Output",
        output,
      ],
      { env, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const [compiled, log, errors] = await Promise.all([
      compiler.exited,
      new Response(compiler.stdout).text(),
      new Response(compiler.stderr).text(),
    ])
    await Bun.write(path.join(root, "compile.log"), log + errors)
    expect(compiled, `Private compiler log retained in ${root}`).toBe(0)
    const child = Bun.spawn([output, root], { env, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await Bun.write(
      path.join(root, "receipt.json"),
      JSON.stringify({ code, pid: child.pid, stdout, stderr, portableCaptureAuthorized: false }),
    )
    expect(code, `Native fixture receipt retained in ${root}`).toBe(0)
    expect(stderr).toBe("")
    expect(stdout.trim().split(/\r?\n/)).toEqual([
      "Offline immutable stage success",
      "Offline immutable stage sharing refused",
      "Offline immutable stage missing refused",
      "Offline immutable stage access refused",
      "Offline immutable stage handles closed",
    ])
    expect(() => process.kill(child.pid, 0)).toThrow()
    await readFile(path.join(root, "stage.bin")).then(
      () => {
        throw new Error("Native stage fixture retained its file handles")
      },
      (err: unknown) => expect(err).toMatchObject({ code: "ENOENT" }),
    )
    for (const [literal, suffix] of [
      ["sharing", "SHARING"],
      ["missing", "MISSING"],
      ["access", "ACCESS"],
      ["resources", "RESOURCES"],
    ]) {
      const generation = crypto.randomUUID()
      try {
        preparation(
          {
            version: 1,
            generation,
            state: "retired",
            restored: true,
            failures: [`Offline immutable stage ${literal} refused`],
            portableCaptureAuthorized: false,
          },
          generation,
        )
        throw new Error("Native refusal granted an image")
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError)
        if (!(err instanceof AggregateError)) throw err
        expect(err.errors[0].code).toBe(`RAYA_OFFLINE_IMMUTABLE_STAGE_${suffix}_REFUSED`)
        expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(root)
      }
    }
    const helper = path.join(root, "helper", "raya-process-host.exe")
    const builder = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve(import.meta.dir, "../../script/kilocode/build-process-host.ps1"),
        "-Output",
        helper,
      ],
      { env, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const [built, result, failure] = await Promise.all([
      builder.exited,
      new Response(builder.stdout).text(),
      new Response(builder.stderr).text(),
    ])
    await Bun.write(path.join(root, "helper-build.log"), result + failure)
    expect(built).toBe(0)
    const data = path.join(root, "source")
    await mkdir(data)
    const source = path.join(data, "object.bin")
    const bytes = Buffer.from([0, 255, 42])
    await writeFile(source, bytes)
    const roots = [{ kind: "json" as const, path: data }]
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    const retained = await withImage(
      {
        roots,
        policy: { version: 1, directories: [data], files: [] },
        helper: { executable: helper, digest },
        registry: path.join(root, "registry"),
      },
      async (image) => {
        const value = assertImage(image, roots)
        const file = value.files.find((file) => file.original === source)
        if (!file) throw new Error("Actual staged object missing")
        expect(await readFile(file.staged)).toEqual(bytes)
        expect(value.portableCaptureAuthorized).toBe(false)
        return image
      },
    )
    expect(() => assertImage(retained, roots)).toThrow()
    expect(await readFile(source)).toEqual(bytes)
    await writeFile(source, "restored source writable")
    await Bun.write(
      path.join(root, "guardian-receipt.json"),
      JSON.stringify({
        helper,
        digest,
        actualStage: true,
        rollbackJoined: true,
        sourceWritable: true,
        portableCaptureAuthorized: false,
      }),
    )
  },
  60000,
)
