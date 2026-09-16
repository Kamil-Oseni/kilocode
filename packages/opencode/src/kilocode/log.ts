import * as Log from "@opencode-ai/core/util/log"
import { InstallationBuildKind } from "@opencode-ai/core/installation/version"
import { EnvAlias } from "@opencode-ai/core/kilocode/env-alias"

export namespace KiloLog {
  export type Input = {
    printLogs?: boolean
    logLevel?: string
  }

  export function configure(input: Input = {}, env: NodeJS.ProcessEnv = process.env) {
    const savedLevel = EnvAlias.read("RAYA_LOG_LEVEL", "KILO_LOG_LEVEL", env)
    const savedPrint = EnvAlias.read("RAYA_PRINT_LOGS", "KILO_PRINT_LOGS", env)
    const level = input.logLevel || savedLevel
    const print = input.printLogs === true ? "1" : savedPrint
    if (level !== undefined) EnvAlias.write("RAYA_LOG_LEVEL", "KILO_LOG_LEVEL", level, env)
    if (print !== undefined) EnvAlias.write("RAYA_PRINT_LOGS", "KILO_PRINT_LOGS", print, env)
  }

  export function options(env: NodeJS.ProcessEnv = process.env) {
    const value = EnvAlias.read("RAYA_LOG_LEVEL", "KILO_LOG_LEVEL", env)?.toUpperCase()
    const level: Log.Level =
      value === "DEBUG" || value === "INFO" || value === "WARN" || value === "ERROR"
        ? value
        : InstallationBuildKind === "release"
          ? "INFO"
          : "DEBUG"
    return {
      print: EnvAlias.read("RAYA_PRINT_LOGS", "KILO_PRINT_LOGS", env) === "1",
      dev: InstallationBuildKind !== "release",
      level,
    }
  }

  export function init(input?: Input) {
    configure(input)
    return Log.init(options())
  }
}
