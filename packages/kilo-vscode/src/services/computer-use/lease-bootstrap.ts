import { ComputerUseLeaseStore, type LeaseStorage } from "./lease-store"
import { ComputerUseRevocationStore } from "./revocation-store"

const unavailable = "Computer Use is unavailable until Raya can read its saved revocation record"

export function createComputerUseLease(storage: LeaseStorage, dir: string) {
  try {
    return {
      lease: new ComputerUseLeaseStore(storage, undefined, new ComputerUseRevocationStore(dir)),
      error: undefined,
    }
  } catch (error) {
    const disabled: LeaseStorage = {
      get: () => undefined,
      update: async () => {
        throw new Error(unavailable)
      },
    }
    return { lease: new ComputerUseLeaseStore(disabled, undefined, undefined, unavailable), error }
  }
}
