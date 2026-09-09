import { expect, test } from "bun:test"
import yargs from "yargs"
import { launch } from "../../../kilo-vscode/src/services/cli-backend/server-utils"
import { resolveNetworkOptionsNoConfig, withNetworkOptions } from "../../src/cli/network"

test("the extension launch overrides standalone network exposure settings", async () => {
  const argv = process.argv
  process.argv = [process.execPath, "kilo", ...launch]
  try {
    const args = await withNetworkOptions(yargs(launch.slice(1))).parse()
    const result = resolveNetworkOptionsNoConfig(args, {
      server: { hostname: "0.0.0.0", port: 7891, mdns: true },
    })
    expect(result.hostname).toBe("127.0.0.1")
    expect(result.port).toBe(0)
    expect(result.mdns).toBe(false)
  } finally {
    process.argv = argv
  }
})
