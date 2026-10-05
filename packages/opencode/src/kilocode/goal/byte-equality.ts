import path from "node:path"
import { Effect, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Equality } from "./criteria"
import * as Artifact from "./artifact"

const normalize = (value: string) =>
  process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value)

/** Only inspect exact artifacts already authorized and cited through successful reads. */
export const equality = (check: Equality, cited: readonly SessionV1.ToolPart[]) =>
  Effect.gen(function* () {
    const revisions = cited.flatMap((part) =>
      part.tool === "read" && part.state.status === "completed"
        ? Artifact.entries(part.state.metadata["rayaRevision"])
        : [],
    )
    const bound = [check.source, check.target].map((selected) =>
      revisions.find(
        (entry) =>
          entry.status === "captured" &&
          entry.bytes !== undefined &&
          normalize(entry.path) === normalize(selected.path) &&
          normalize(entry.canonical) === normalize(selected.canonical),
      ),
    )
    if (bound.some((entry) => !entry || entry.status !== "captured")) return false
    const fs = yield* Effect.serviceOption(FSUtil.Service)
    if (Option.isNone(fs)) return false
    for (const entry of bound) {
      if (!entry || entry.status !== "captured") return false
      const now = yield* Artifact.capture(fs.value, entry.path, entry.canonical)
      if (
        now.status !== "captured" ||
        now.sha256 !== entry.sha256 ||
        now.bytes !== entry.bytes ||
        now.mode !== entry.mode ||
        now.sha256 !== check.source.sha256 ||
        now.bytes !== check.source.bytes
      )
        return false
    }
    return true
  })
