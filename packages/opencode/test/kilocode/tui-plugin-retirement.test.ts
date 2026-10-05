import { test } from "bun:test"
import { plugin } from "./tui-plugin-child"

for (const mode of ["success", "failure", "held", "init", "deactivation", "initial-failure"])
  test(`actual local plugin retirement ${mode}`, () => plugin(mode), 25000)
