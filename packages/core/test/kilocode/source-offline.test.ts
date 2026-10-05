import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of ["image", "native", "crash", "parent", "long"])
  test.skipIf(process.platform !== "win32")(
    `actual offline guardian ${mode} preserves private source and refuses false capture`,
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "raya-offline-check-"))
      const fixture = path.join(import.meta.dir, "fixtures")
      const command =
        mode === "parent"
          ? [
              "powershell.exe",
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              path.join(fixture, "source-offline-parent.ps1"),
            ]
          : [
              process.execPath,
              path.join(
                fixture,
                mode === "image"
                  ? "source-offline-image.ts"
                  : mode === "long"
                    ? "source-offline-long.ts"
                    : "source-offline-native.ts",
              ),
              ...(mode === "crash" ? ["--crash"] : []),
            ]
      const child = Bun.spawn(command, {
        cwd: path.resolve(import.meta.dir, "../.."),
        windowsHide: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          KILO_TEST_HOME: root,
          LOCALAPPDATA: path.join(root, "local"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          KILO_DB: path.join(root, "unused.db"),
          RAYA_DB: path.join(root, "unused.db"),
          KILO_AUTH_CONTENT: "{}",
          RAYA_AUTH_CONTENT: "{}",
          KILO_DISABLE_MODELS_FETCH: "1",
          RAYA_DISABLE_MODELS_FETCH: "1",
          RAYA_SOURCE_OFFLINE_TEST_BUN: process.execPath,
          PSModulePath: path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "Modules"),
        },
      })
      const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
      const timer = setTimeout(() => child.kill("SIGKILL"), 60000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
        await Bun.write(path.join(root, "stdout.log"), stdout)
        await Bun.write(path.join(root, "stderr.log"), stderr)
        expect(code, `Retained ${root}: ${stderr}`).toBe(0)
        const receipt = JSON.parse(stdout)
        await Bun.write(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2))
        expect(receipt.portableCaptureAuthorized).toBe(false)
        if (mode === "long") {
          expect(receipt.source).toBeGreaterThan(260)
          expect(receipt.staged).toBeGreaterThan(260)
          expect(receipt.denied).toEqual([true, true, true, true, true])
          expect(receipt.bytes).toBe(true)
          expect(receipt.gitPack).toBe(true)
          expect(receipt.writable).toBe(true)
          expect(receipt.recovered).toHaveLength(1)
          expect(receipt.repeated).toHaveLength(1)
          expect(receipt.recovered[0].recovered).toBe(true)
          expect(receipt.repeated[0].recovered).toBe(true)
        }
        if (mode === "image") {
          expect(receipt.first.row).toBe("durable-wal")
          expect(receipt.first.rawNamespaceBlocked).toEqual([true, true, true, true, true, true])
          expect(receipt.first.mutation).toBe(true)
          expect(receipt.first.forge).toBe(true)
          expect(receipt.expired).toBe(true)
          expect(receipt.sourceHashesUnchanged).toBe(true)
          expect(receipt.retainedFailure).toBe(true)
          expect(receipt.regularFileRoot).toBe(true)
          expect(receipt.existingWriteRefused).toBe(true)
          expect(receipt.preparation).toContain("RAYA_OFFLINE_EXCLUSIVE_SOURCE_HANDLE_REFUSED")
          expect(receipt.callbackNeverEntered).toBe(true)
          expect(receipt.unclassified).toBe(true)
          expect(receipt.hardlinkRefused).toBe(true)
          expect(receipt.junctionRefused).toBe(true)
          expect(receipt.authenticatedJournalTamperRefused).toBe(true)
          expect(receipt.recoveredGenerations).toBe(6)
          expect(receipt.repeatedStartupGenerations).toBe(6)
          expect(receipt.unusedRegistryRealizedNoHelper).toBe(true)
          expect(receipt.unknownRegistryEntryRefused).toBe(true)
        }
        if (mode === "native") {
          expect(receipt.code).toBe(0)
          expect(receipt.foreign).toBe(0)
          expect(receipt.denied).toEqual([true, true, true])
          expect(receipt.binaryUnchanged).toBe(true)
          expect(receipt.retired.restored).toBe(true)
        }
        if (mode === "crash") {
          expect(receipt.captureSuccessful).toBe(false)
          expect(receipt.recoveryCode).toBe(0)
          expect(receipt.restoredWritable).toBe(true)
          expect(receipt.binaryUnchanged).toBe(true)
        }
        if (mode === "parent") {
          expect(receipt.sourceCode).toBe(0)
          expect(receipt.guardianCode).toBe(1)
          expect(receipt.nativeHandleHeldBeforeParentDeath).toBe(true)
          expect(receipt.exactDaclRestored).toBe(true)
          expect(receipt.sourceWritable).toBe(true)
          expect(receipt.captureSuccessful).toBe(false)
        }
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
      }
    },
    65000,
  )
