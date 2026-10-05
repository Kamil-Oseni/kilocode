import { createEffect, untrack, type Accessor } from "solid-js"

/** Load preferences only after the backend can serve them, including reconnects. */
export function bootstrap(connected: Accessor<boolean>, request: () => void) {
  createEffect(() => {
    if (!connected()) return
    untrack(request)
  })
}
