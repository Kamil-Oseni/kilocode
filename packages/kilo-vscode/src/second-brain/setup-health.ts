import type { BrainState } from "../shared/second-brain"
import type { BrainService } from "./service"
import type { BrainControl } from "./control"

/** Hydrate approved setup from validated health metadata; never index notes or enable saving. */
export async function hydrate(
  service: BrainService,
  control: BrainControl,
  state: BrainState,
  signal: AbortSignal,
  guard: () => void,
) {
  const check = () => {
    signal.throwIfAborted()
    guard()
  }
  check()
  if (!state.configured || control.snapshot().status === "uncertain") return
  if (
    state.status === "unavailable" &&
    ["managed_generation_conflict", "closed_pair_recovery_required", "control_uncertain", "setup_invalid"].includes(
      state.code ?? "",
    )
  )
    return
  if (control.snapshot().status !== "unchecked" && service.captureSnapshot()) return
  await service.run(
    undefined,
    (value) => {
      check()
      if (value.status === "ready" && value.control) control.observe(value.control)
    },
    {},
    { budget: 1, parent: signal },
  )
  check()
}
