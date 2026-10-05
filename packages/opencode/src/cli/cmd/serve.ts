import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless kilo server",
  // Server loads instances per-request via x-kilo-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false, // kilocode_change
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.KILO_SERVER_PASSWORD) {
      console.log("Warning: RAYA_SERVER_PASSWORD or KILO_SERVER_PASSWORD is not set; server is unsecured.") // kilocode_change
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))

    // kilocode_change start
    const urls = server.urls

    console.log(`kilo server listening on ${urls.bind}`)
    if (urls.local !== urls.bind) console.log(`  Local:   ${urls.local}`)
    if (urls.network) console.log(`  Network: ${urls.network}`)
    // kilocode_change end

    // kilocode_change start - joined signal shutdown retains cleanup refusal
    const { waitForServe } = yield* Effect.promise(() => import("../../kilocode/cli/serve-shutdown"))
    yield* Effect.promise(() => waitForServe(server))
    // kilocode_change end
  }),
})
