import { Effect, Schema } from "effect"
import { Desktop } from "@/kilocode/desktop/service"
import { SelectedWindowTarget } from "@/kilocode/desktop/protocol"
import type { Request } from "@/kilocode/desktop/protocol"
import { TaskAuthority } from "./task-authority"

export namespace TaskComputer {
  type Proof = {
    grantID: string
    windowID?: string
    identity?: string
    binding?: { version: 1; windowID: string; identity: string }
  }
  export function admit(input: {
    access?: TaskAuthority.Access
    desktop?: Desktop.Interface
    sessionID: Request["sessionID"]
    parent: { metadata?: Record<string, unknown> }
    resumed?: { id: string; metadata?: Record<string, unknown> }
    target?: Schema.Schema.Type<typeof SelectedWindowTarget>
  }) {
    return Effect.gen(function* () {
      if (input.target && input.access !== "computer")
        throw new Error("A selected desktop target requires computer access")
      if (input.access !== "computer") return
      if (!input.desktop) throw new Error("Computer Use is unavailable in this client")
      if (TaskAuthority.read(input.parent.metadata) === "computer")
        throw new Error("Computer Use children cannot delegate desktop authority further")
      const prior = input.resumed
        ? TaskAuthority.proof(input.resumed.metadata, input.resumed.id, input.sessionID)
        : undefined
      if (prior && input.target && input.target.windowID !== prior.windowID)
        throw new Error("Computer Use child target changed; the existing child cannot be rebound")
      if (prior && !prior.windowID && input.target)
        throw new Error("A legacy all-app Computer Use child cannot gain a selected target on Resume")
      const target = prior?.windowID ? { version: 1 as const, windowID: prior.windowID } : input.target
      const result = yield* input.desktop.request({
        operation: "authorize",
        sessionID: input.sessionID,
        surface: "desktop",
        action: "observe",
        sensitive: false,
        admission: "computer_child",
        ...(target ? { target } : {}),
      })
      if (result.operation !== "authorize" || result.decision !== "allow" || !result.grantID)
        throw new Error("Computer Use child needs an active parent desktop grant")
      if (!!result.windowID !== !!result.identity)
        throw new Error("Selected Computer Use grant lacks an exact window identity")
      if (
        result.binding &&
        (result.binding.version !== 1 ||
          result.binding.windowID !== result.windowID ||
          result.binding.identity !== result.identity ||
          !/^0x[0-9A-F]+$/.test(result.binding.windowID) ||
          !/^[0-9A-F]{64}$/.test(result.binding.identity))
      )
        throw new Error("Computer Use child binding is invalid or differs from its authorization result")
      if (target && (!result.binding || result.windowID !== target.windowID))
        throw new Error("Computer Use child target differs from the requested versioned binding")
      if (
        prior &&
        (prior.grantID !== result.grantID ||
          prior.windowID !== result.windowID ||
          prior.identity !== result.identity)
      )
        throw new Error("Computer Use grant changed; the existing child cannot be rebound")
      return { grantID: result.grantID, windowID: result.windowID, identity: result.identity, binding: result.binding }
    })
  }

  export function bind(
    metadata: Record<string, unknown>,
    parentSessionID: string,
    childSessionID: string,
    proof: Proof,
  ) {
    if (proof.binding)
      return TaskAuthority.bindSelected(metadata, {
        parentSessionID,
        childSessionID,
        grantID: proof.grantID,
        binding: proof.binding,
      })
    return TaskAuthority.bind(metadata, {
      parentSessionID,
      childSessionID,
      grantID: proof.grantID,
      ...(proof.windowID ? { windowID: proof.windowID } : {}),
      ...(proof.identity ? { identity: proof.identity } : {}),
    })
  }
}
