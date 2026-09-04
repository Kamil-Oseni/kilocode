import { expect, test } from "bun:test"
import path from "path"
import { designerPrompt, sealDesigner } from "../../src/kilocode/agent"

test("packaged designer doctrine matches docs/designer.md", async () => {
  const docs = await Bun.file(path.join(import.meta.dir, "../../../../docs/designer.md")).text()
  const packed = await Bun.file(path.join(import.meta.dir, "../../src/kilocode/agent/designer.txt")).text()
  const body = docs.replace(/^---[\s\S]*?---\r?\n/, "").trim()
  expect(packed.trim()).toBe(body)
})

test("sealDesigner restores the packaged doctrine after an overlay prompt", () => {
  const agents = { designer: { prompt: "overlay only" } }
  sealDesigner(agents)
  expect(agents.designer.prompt).toBe(designerPrompt())
  expect(agents.designer.prompt).toContain("Design from first principles, not vibes")
  expect(agents.designer.prompt).not.toContain("overlay only")
})
