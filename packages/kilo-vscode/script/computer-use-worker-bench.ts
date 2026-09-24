import { WindowsDesktopDriver } from "../src/services/computer-use/desktop-windows"

type Sample = {
  wall: number
  acquisition: number
  preparation: number
  semantics?: number
  driver: number
}

const count = Number(Bun.argv[2] ?? 20)
if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("Choose 1 to 100 benchmark observations")

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(2))
}

function summary(samples: Sample[]) {
  const stage = (key: keyof Sample) => {
    const values = samples.map((sample) => sample[key]).filter((value): value is number => typeof value === "number")
    return values.length ? { p50: percentile(values, 0.5), p95: percentile(values, 0.95) } : undefined
  }
  return {
    count: samples.length,
    wallMs: stage("wall"),
    acquisitionMs: stage("acquisition"),
    preparationMs: stage("preparation"),
    semanticsMs: stage("semantics"),
    driverMs: stage("driver"),
  }
}

const driver = new WindowsDesktopDriver()
const visual: Sample[] = []
const semantic: Sample[] = []
let failure: unknown
const started = performance.now()
try {
  driver.startCapture((error) => {
    failure = error
  })
  await Bun.sleep(2_000)
  for (let index = 0; index < count; index++) {
    if (failure) throw failure
    const before = performance.now()
    const frame = await driver.observe({ semantics: false })
    visual.push({
      wall: performance.now() - before,
      acquisition: frame.timing.acquisitionMs,
      preparation: frame.timing.preparationMs,
      driver: frame.timing.totalMs,
    })
    await Bun.sleep(50)
  }
  for (let index = 0; index < count; index++) {
    if (failure) throw failure
    const before = performance.now()
    const frame = await driver.observe()
    semantic.push({
      wall: performance.now() - before,
      acquisition: frame.timing.acquisitionMs,
      preparation: frame.timing.preparationMs,
      semantics: frame.timing.semanticsMs,
      driver: frame.timing.totalMs,
    })
  }
  const memory = process.memoryUsage()
  console.log(
    JSON.stringify(
      {
        format: "raya.computer-use-worker-benchmark",
        version: 1,
        mode: "local-source-host",
        elapsedMs: Number((performance.now() - started).toFixed(2)),
        visual: summary(visual),
        semantic: summary(semantic),
        processMemoryBytes: { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external },
        note: "No pixels are saved. This is not an installed-host or model/provider benchmark.",
      },
      undefined,
      2,
    ),
  )
} catch (error) {
  console.error(
    JSON.stringify({
      format: "raya.computer-use-worker-benchmark",
      version: 1,
      mode: "local-source-host",
      status: "unavailable",
      reason:
        error instanceof Error && /no foreground window/i.test(error.message)
          ? "no_foreground_window"
          : "capture_host_error",
      visualSamples: visual.length,
      semanticSamples: semantic.length,
      note: "No usable latency result; no pixels were saved.",
    }),
  )
  process.exitCode = 2
} finally {
  driver.stopCapture()
  driver.cancel()
}
