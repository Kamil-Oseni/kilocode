import { retire } from "./database-retirement"
import { errorMessage } from "@/util/error"
import { lifecycle } from "./lifecycle"
import * as Log from "@opencode-ai/core/util/log"
import { drainFileLoggers } from "@opencode-ai/core/kilocode/file-logger"
import { finalize as daemon } from "../daemon/child"
import { closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"

function message(err: unknown): string {
  if (err instanceof AggregateError) return [err.message, ...err.errors.map(message)].join("\n")
  return errorMessage(err)
}

function receipt(success: boolean) {
  return lifecycle([
    async () => {
      const { finalize } = await import("../migration/source-host")
      await finalize(success)
    },
    () => daemon(success),
  ]).run()
}

/** Commands have settled before this outer boundary retires their owning runtimes. */
export async function finish(tasks: readonly (() => void | Promise<void>)[], publish?: () => void | Promise<void>) {
  try {
    // Runtime finalizers may log their last persistence outcome before the file stream closes.
    await lifecycle([...tasks, retire, drainFileLoggers, () => Log.drain()]).run()
    await receipt(Number(process.exitCode ?? 0) === 0)
  } catch (err) {
    if (Number(process.exitCode ?? 0) === 0) process.exitCode = 1
    process.stderr.write(`Raya shutdown failed: ${message(err)}\n`)
    try {
      await receipt(false)
    } catch (failure) {
      process.stderr.write(`Raya retirement receipt failed: ${message(failure)}\n`)
    }
  } finally {
    try {
      await closeProcessProfile()
    } catch (failure) {
      if (Number(process.exitCode ?? 0) === 0) process.exitCode = 1
      process.stderr.write(`Raya process profile retirement failed: ${message(failure)}\n`)
    }
    if (Number(process.exitCode ?? 0) === 0 && publish) {
      try {
        await publish()
      } catch {
        process.exitCode = 1
        process.stderr.write("Raya completion publication failed.\n")
      }
    }
    // Preserve explicit process termination even when cleanup or reporting fails.
    process.exit()
  }
}
