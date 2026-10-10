import { createHash } from "node:crypto"
import path from "node:path"
import yargs from "yargs"
import z from "zod"
import { ImportReviewSchema } from "@opencode-ai/core/kilocode/profile-import-review"
import { read, secret, text } from "./profile-import-input"
import { isolate } from "./profile-import-isolation"

/** Runs before ordinary bootstrap. Only authenticated mapping metadata reaches stdout after retirement. */
export async function run(args: readonly string[]) {
  const state: { runtime?: string; output?: string } = {}
  try {
    const input = await yargs([...args])
      .scriptName("kilo profile-import-review")
      .command("$0 <archive>", "Inspect encrypted archive workspace mappings without restoring")
      .option("sha256", { type: "string", demandOption: true })
      .strict()
      .exitProcess(false)
      .help()
      .fail(() => {
        throw new Error("Invalid review arguments")
      })
      .parseAsync()
    if (input.help) return
    const file = z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => path.isAbsolute(value) && path.normalize(value) === value && !/[\0\r\n]/.test(value))
      .parse(input.archive)
    const digest = z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .transform((value) => value.toLowerCase())
      .parse(input.sha256)
    const bytes = await read(file, 180 * 1024 * 1024)
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("Archive digest differs")
    const encoded = text(bytes)
    if (process.stdin.isTTY) throw new Error("Review requires private stdin")
    const password = await secret(process.stdin)
    state.runtime = await isolate()
    const { unseal } = await import("./profile-bundle")
    const { identity } = await import("./profile-workspaces")
    const original = await unseal(encoded, password)
    if (original.workspaces.length > 128) throw new Error("Review workspace capacity exceeded")
    const value = ImportReviewSchema.parse({
      format: "raya.profile-import-review",
      version: 1,
      archive: { id: original.id, sha256: digest, bytes: bytes.length },
      workspaces: original.workspaces.map((source) => {
        const managed = original.artifacts?.worktrees.find((item) => identity(item.workspace) === identity(source))
        if (!managed) return { source, kind: "ordinary" as const }
        return {
          source,
          kind: "managed" as const,
          project: managed.project,
          name: managed.name,
          destination: ["data", "kilo", "worktree", managed.project, managed.name],
        }
      }),
      completeProfileCoverage: false,
      portableCaptureAuthorized: false,
      activation: "held",
      replay: false,
      reconnectCredentials: true,
      uncertainWork: "held-no-replay",
    })
    const output = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(output) > 1024 * 1024) throw new Error("Review output capacity exceeded")
    state.output = output
  } catch {
    process.exitCode = 1
    process.stderr.write("Raya archive inspection refused. Verify the archive, digest and private stdin.\n")
  } finally {
    if (state.runtime) {
      const { finish } = await import("../cli/finish")
      await finish([], () => {
        if (state.output) process.stdout.write(state.output)
      })
    }
  }
}
