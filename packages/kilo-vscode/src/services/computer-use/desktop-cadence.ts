export const WATCH = { frames: 16, minimum: 50, maximum: 1_000, budget: 10_000, capture: 500 } as const

type Visual = {
  windowID: string
  location?: string
  width: number
  height: number
  mime: string
  data: string
}

export function bounded(frames: number, interval: number): boolean {
  if (!Number.isInteger(frames) || frames < 2 || frames > WATCH.frames) return false
  if (!Number.isInteger(interval) || interval < WATCH.minimum || interval > WATCH.maximum) return false
  return frames * WATCH.capture + (frames - 1) * interval <= WATCH.budget
}

export function changed(previous: Visual | undefined, frame: Visual): boolean {
  return (
    !previous ||
    previous.windowID !== frame.windowID ||
    previous.location !== frame.location ||
    previous.width !== frame.width ||
    previous.height !== frame.height ||
    previous.mime !== frame.mime ||
    previous.data !== frame.data
  )
}

export function limit<T>(work: Promise<T>, ms: number, expire: () => void | Promise<void>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(
      () => {
        if (settled) return
        settled = true
        try {
          const result = expire()
          void Promise.resolve(result).catch((error) =>
            console.error("[Raya] Desktop watch cancellation failed", error),
          )
        } catch (error) {
          console.error("[Raya] Desktop watch cancellation failed", error)
        }
        reject(new Error("Desktop watch exceeded the ten-second local capture budget"))
      },
      Math.max(0, ms),
    )
    work.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export class DesktopCadence {
  private delay: number = WATCH.minimum

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < WATCH.minimum || maximum > WATCH.maximum)
      throw new Error("Desktop watch cadence is outside the bounded interval")
  }

  next(changed: boolean): number {
    this.delay = changed ? WATCH.minimum : Math.min(this.maximum, this.delay * 2)
    return this.delay
  }
}
