import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { launch, memberContext } from "@opencode-ai/core/kilocode/source-launch"
import { prepare } from "@opencode-ai/core/kilocode/source-profile"
import { startup } from "@opencode-ai/core/kilocode/source-offline"

/** The compiled producer has no Global imports or profile writer side effects. */
async function enter() {
  const args = process.argv.slice(2)
  if (args[0] === "profile-import") {
    const { run } = await import("../migration/profile-import")
    await run(args.slice(1))
    return
  }
  const controller = args.length === 1 && ["__profile-source-successor", "__profile-maintenance"].includes(args[0])
  if (
    process.platform !== "win32" ||
    /^bun(?:\.exe)?$/i.test(path.basename(process.execPath)) ||
    controller ||
    (await memberContext())
  ) {
    await import("../../index")
    return
  }
  const executable = await realpath(process.execPath)
  const cwd = await realpath(process.cwd())
  const digest = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex")
  await startup()
  const profile = await prepare({ home: os.homedir(), cwd, env: process.env })
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
  const source = await launch({
    executable,
    digest,
    cwd,
    args,
    env,
    roots: profile.roots,
    policy: profile.policy,
    timeout: 60000,
    stdio: "inherit",
  })
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
  const handlers = signals.map((signal) => {
    const handler = () => {
      try {
        process.kill(source.ticket.header.pid, signal)
      } catch (err) {
        console.error("Source signal delivery failed", err instanceof Error ? err.name : "unknown")
      }
    }
    process.on(signal, handler)
    return { signal, handler }
  })
  try {
    await source.start()
    const result = await source.sourceExit
    // The kernel guardian retains persistent descendants independently. The
    // foreground command exits with the source status, without claiming capture.
    process.exitCode = result.code
  } catch (err) {
    await source.abort()
    throw err
  } finally {
    for (const { signal, handler } of handlers) process.removeListener(signal, handler)
  }
  process.exit(process.exitCode)
}

try {
  await enter()
} catch {
  process.stderr.write("Raya protected startup failed.\n")
  process.exitCode = 1
}
