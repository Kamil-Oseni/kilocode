import { Effect } from "effect"
import type { Storage } from "@/storage/storage"

const codes = new Set(["EACCES", "EBUSY", "EPERM"])

function locked(err: Storage.Error) {
  if (err._tag !== "PlatformError") return false
  if (err.reason._tag === "Busy" || err.reason._tag === "WouldBlock") return true
  if (!("cause" in err.reason)) return false
  const cause = err.reason.cause
  return typeof cause === "object" && cause !== null && "code" in cause && codes.has(String(cause.code))
}

/** Windows may briefly deny a read while another process atomically publishes or removes the claim. */
export function read(
  storage: { read: (key: string[]) => Effect.Effect<unknown, Storage.Error> },
  key: string[],
  attempt = 0,
): Effect.Effect<unknown, Storage.Error> {
  return storage
    .read<T>(key)
    .pipe(
      Effect.catchIf(locked, (err) =>
        attempt >= 7
          ? Effect.fail(err)
          : Effect.sleep(`${25 * (attempt + 1)} millis`).pipe(Effect.andThen(read(storage, key, attempt + 1))),
      ),
    )
}
