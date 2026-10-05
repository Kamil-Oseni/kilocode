import { expect, test } from "bun:test"
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { NativeProcess } from "../../src/kilocode/process-host"

for (const mode of ["guardian", "parent"])
  for (const layout of ["separate", "normal"])
    test.skipIf(process.platform !== "win32")(
      `actual v2 ${mode} controlled crash recovers only negative namespace metadata (${layout} registry)`,
      async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "raya-negative-crash-"))
        const helper = path.join(root, "raya-process-host.exe")
        await cp(process.env.RAYA_OFFLINE_TEST_HELPER ?? (await NativeProcess.source()), helper)
        const digest = createHash("sha256")
          .update(await readFile(helper))
          .digest("hex")
        const child = Bun.spawn(
          [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(import.meta.dir, "fixtures", "source-offline-negative-crash.ps1"),
            "-Root",
            root,
            "-Helper",
            helper,
            "-Bun",
            process.execPath,
            "-Mode",
            mode,
            "-Layout",
            layout,
          ],
          {
            windowsHide: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              PSModulePath: path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "Modules"),
            },
          },
        )
        const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
        let forced = false
        const timer = setTimeout(() => {
          forced = true
          child.kill("SIGKILL")
        }, 55000)
        try {
          const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
          await Promise.all([
            writeFile(path.join(root, "stdout.log"), stdout),
            writeFile(path.join(root, "stderr.log"), stderr),
          ])
          expect(forced, `Retained ${root}`).toBeFalse()
          expect(code, `Retained ${root}: ${stderr}`).toBe(0)
          const receipt = JSON.parse(stdout)
          await writeFile(
            path.join(root, "receipt.json"),
            JSON.stringify({ ...receipt, helperDigest: digest }, null, 2),
          )
          expect(receipt).toMatchObject({
            nativeBirthsHeld: true,
            exactAclRestored: true,
            negativePathsAbsent: true,
            siblingUnchanged: true,
            journalParentCount: 1,
            journalOnlyDirectories: true,
            emptyStages: true,
            zeroCapturedFiles: true,
            freshRecovery: true,
            repeatedRecovery: true,
            ownedPidsAbsent: true,
            captureSuccessful: false,
            portableCaptureAuthorized: false,
          })
          expect(receipt.guardianCode).toBe(mode === "guardian" ? 77 : 1)
          expect(receipt.sourceCode).toBe(mode === "guardian" ? 0 : 91)
        } finally {
          clearTimeout(timer)
          if (child.exitCode === null) child.kill("SIGKILL")
          await child.exited
        }
      },
      60000,
    )
