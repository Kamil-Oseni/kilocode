import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assess, prepare, score } from "./computer-use-settings-task"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "raya-settings-task-test-"))
  dirs.push(dir)
  const ext = join(dir, "extension")
  const root = join(dir, "task")
  await mkdir(join(ext, "bin"), { recursive: true })
  await writeFile(
    join(ext, "package.json"),
    JSON.stringify({ publisher: "eden", name: "raya", version: "7.4.23-snapshot+test" }),
  )
  await writeFile(join(ext, "bin", "raya-desktop-capture.exe"), "capture bytes")
  await writeFile(join(ext, "bin", "raya-desktop-input.exe"), "input bytes")
  return { ext, root }
}

const pages = [
  { label: "Display", marker: "Display resolution" },
  { label: "About", marker: "Device specifications" },
  { label: "Bluetooth & devices", marker: "Add device" },
] as const

function observation(page: number) {
  return {
    page: pages[page].label,
    processPath: "C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe",
    genuineSettings: true,
    foreground: true,
    threadDesktop: "Default",
    inputDesktop: "Default",
    names: [pages[page].label, pages[page].marker],
  }
}

describe("installed Windows Settings navigation task", () => {
  test("prepare records a randomized read-only destination, while setup alone cannot pass", async () => {
    const item = await fixture()
    const task = await prepare(item.root, item.ext)
    expect(task.manifest.scenario).toBe("settings-navigation")
    expect(task.instruction).toContain("Do not change any setting")
    expect((await score(item.root)).releaseGateEligible).toBe(false)
  }, 20_000)

  test("requires verified foreground Settings, matching semantic page, and the input desktop", () => {
    const good = observation(0)
    expect(assess(0, good).correctFinalState).toBe(true)
    expect(assess(1, good).correctFinalState).toBe(false)
    expect(assess(0, { ...good, foreground: false }).correctFinalState).toBe(false)
    expect(assess(0, { ...good, processPath: "C:\\Temp\\SystemSettings.exe" }).correctFinalState).toBe(false)
    expect(assess(0, { ...good, inputDesktop: "CodexSandboxDesktop-1" }).correctFinalState).toBe(false)
    expect(assess(0, { ...good, names: [good.page] }).correctFinalState).toBe(false)
    expect(assess(0, { ...good, genuineSettings: false }).correctFinalState).toBe(false)
  })

  test("rejects script tampering and replay artifacts", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    await writeFile(join(item.root, "settings-probe.ps1"), "fake")
    await writeFile(join(item.root, "observation.json"), JSON.stringify(observation(0)))
    const result = await score(item.root)
    expect(result.correctFinalState).toBe(false)
    expect(result.changed).toEqual(["settings-probe.ps1"])
    expect(result.unexpected).toEqual(["observation.json"])
  })

  test("rejects altered contract and occupied task directory", async () => {
    const item = await fixture()
    await mkdir(item.root)
    await writeFile(join(item.root, "keep.txt"), "keep")
    expect(prepare(item.root, item.ext)).rejects.toThrow("empty disposable task directory")
    await rm(item.root, { recursive: true })
    await prepare(item.root, item.ext)
    const path = join(item.root, "task.json")
    const data = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    data.scenario = "dialog-handling"
    await writeFile(path, JSON.stringify(data))
    expect(score(item.root)).rejects.toThrow("Invalid or modified settings task manifest")
  })
})
