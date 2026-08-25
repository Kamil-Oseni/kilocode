// raya_change - Milestone C clickable option-card contracts
import { describe, expect, it } from "bun:test"
import path from "path"
import {
  questionOptionValue,
  resolveQuestionMode,
  toggleAnswer,
} from "../../webview-ui/src/components/chat/question-dock-utils"

const root = path.resolve(import.meta.dir, "../..")
const read = (file: string) => Bun.file(path.join(root, file)).text()

describe("Milestone C option cards", () => {
  it("uses stable ids for clicks while preserving labels for display", () => {
    const option = { id: "raya-option:code", label: "Code", description: "Implement it", mode: "code" }

    expect(questionOptionValue(option)).toBe("raya-option:code")
    expect(resolveQuestionMode([option], "raya-option:code")).toBe("code")
  })

  it("supports selecting several independent option ids", () => {
    const first = toggleAnswer([], "raya-option:types")
    const second = toggleAnswer(first, "raya-option:tests")

    expect(second).toEqual(["raya-option:types", "raya-option:tests"])
  })

  it("submits a single ask_options click over the existing question channel", async () => {
    const dock = await read("webview-ui/src/components/chat/QuestionDock.tsx")
    const bridge = await read("src/kilo-provider-utils.ts")
    const message = await read("webview-ui/src/components/chat/AssistantMessage.tsx")

    expect(dock).toContain("if (single() && props.request.autoSubmit)")
    expect(dock).toContain("reply(answers)")
    expect(dock).toContain("<Show when={question()?.custom !== false}>")
    expect(bridge).toContain("autoSubmit: event.properties.autoSubmit")
    expect(message).toContain("matchToolRequest(part, undefined, session.questions())")
  })
})
