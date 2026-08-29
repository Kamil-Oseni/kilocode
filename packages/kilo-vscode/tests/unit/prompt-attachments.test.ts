// raya_change - verify the composer exposes its existing attachment transport
import { describe, expect, test } from "bun:test"
import path from "node:path"

const root = path.join(import.meta.dir, "../..")
const read = (file: string) => Bun.file(path.join(root, file)).text()

describe("Raya prompt attachments", () => {
  test("offers a multi-file picker and sends selected files through the attachment pipeline", async () => {
    const prompt = await read("webview-ui/src/components/chat/PromptInput.tsx")
    const hook = await read("webview-ui/src/hooks/useImageAttachments.ts")

    expect(prompt).toContain('type="file"')
    expect(prompt).toContain("multiple")
    expect(prompt).toContain('icon="plus"')
    expect(prompt).toContain('language.t("prompt.action.attach")')
    expect(prompt).toContain("imageAttach.add(file)")
    expect(prompt).toContain("...imgFiles")
    expect(hook).toContain('mime: file.type || "application/octet-stream"')
    expect(hook).not.toContain("if (!isAcceptedImageType(file.type)) return")
  })
})
