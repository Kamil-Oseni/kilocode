/** Local PCM admission only. No microphone, detector model, STT, or resident runtime is installed here. */
type Detector = {
  accept(pcm: Int16Array): boolean
  reset(): void
  close(): Promise<void>
}

export class WakeController {
  #enabled = false
  #paused = true
  #playing = false
  #closed = false
  #active?: { abort: AbortController; job: Promise<void> }
  #closing?: Promise<void>
  #errors: unknown[] = []

  constructor(
    private readonly detector: Detector,
    private readonly capture: (signal: AbortSignal) => Promise<void>,
  ) {}

  state() {
    return {
      enabled: this.#enabled,
      paused: this.#paused,
      playing: this.#playing,
      capturing: this.#active !== undefined,
      closed: this.#closed,
    }
  }

  enable() {
    if (this.#closed) throw new Error("Wake controller is closed")
    if (this.#active) throw new Error("Wake capture is still settling")
    try {
      this.detector.reset()
    } catch (err) {
      this.#errors.push(err)
      this.#paused = true
      throw err
    }
    this.#enabled = true
    this.#paused = false
  }

  /** Pause immediately fences PCM; completion joins the original accepted capture. */
  pause(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#paused = true
    return this.#quiesce()
  }

  cancel(): Promise<void> {
    return this.pause()
  }

  disable(): Promise<void> {
    this.#enabled = false
    return this.pause()
  }

  /** Playback completion never resumes a paused/error generation. */
  playback(value: boolean): Promise<void> {
    if (this.#closing) return this.#closing
    this.#playing = value
    if (value) return this.#quiesce()
    return Promise.resolve()
  }

  /** At most 100ms of mono signed 16-bit, 16kHz PCM; no pre-wake capture callback. */
  feed(pcm: Int16Array, rate: number): boolean {
    if (!this.#enabled || this.#paused || this.#playing || this.#closed || this.#active) return false
    if (!(pcm instanceof Int16Array) || rate !== 16000 || pcm.length === 0 || pcm.length > 1600) {
      throw new Error("Invalid local wake PCM frame")
    }
    const frame = pcm.slice()
    try {
      if (!this.detector.accept(frame)) return false
      this.detector.reset()
      const abort = new AbortController()
      // Reserve before invoking any asynchronous capture producer.
      const slot = { abort, job: Promise.resolve() }
      this.#active = slot
      slot.job = Promise.resolve()
        .then(() => {
          if (abort.signal.aborted) return
          return this.capture(abort.signal)
        })
        .catch((err: unknown) => {
          this.#errors.push(err)
          this.#paused = true
        })
        .finally(() => {
          if (this.#active === slot) this.#active = undefined
        })
      return true
    } catch (err) {
      this.#errors.push(err)
      this.#paused = true
      throw err
    } finally {
      frame.fill(0)
    }
  }

  /** Input EOF and shutdown share one permanent fence and original finalizer join. */
  end(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closed = true
    this.#enabled = false
    this.#paused = true
    this.#closing = this.#quiesce().then(async () => {
      await Promise.resolve()
        .then(() => this.detector.close())
        .catch((err: unknown) => this.#errors.push(err))
      if (this.#errors.length) throw new AggregateError([...this.#errors], "Local wake retirement failed")
    })
    return this.#closing
  }

  #quiesce(): Promise<void> {
    this.#active?.abort.abort()
    try {
      this.detector.reset()
    } catch (err) {
      this.#errors.push(err)
      this.#paused = true
    }
    return this.#active?.job ?? Promise.resolve()
  }
}
