import { schedulerQuiesce } from "../task/admission"
import { lifecycle } from "./lifecycle"

/** Join accepted callbacks before closing their instance scopes; retain both cleanup failures. */
export function retireCommand(dispose: () => Promise<void>, quiesce = schedulerQuiesce) {
  return lifecycle([quiesce, dispose]).run()
}
