import { describe, expect, it } from "bun:test"
import { splitConfigByScope } from "../../webview-ui/src/utils/config-scope"

describe("splitConfigByScope", () => {
  it("keeps indexing configuration out of project config", () => {
    const split = splitConfigByScope({
      indexing: {
        enabled: true,
        provider: "ollama",
      },
    })

    expect(split.global).toEqual({ indexing: { enabled: true, provider: "ollama" } })
    expect(split.project).toEqual({})
  })

  it("writes indexing provider settings to global config", () => {
    const split = splitConfigByScope({
      indexing: {
        provider: "ollama",
      },
    })

    expect(split.global).toEqual({ indexing: { provider: "ollama" } })
    expect(split.project).toEqual({})
  })

  it("writes the speech-to-text model setting to global config", () => {
    const split = splitConfigByScope({
      experimental: {
        speech_to_text_model: "openai/gpt-4o-mini-transcribe",
      },
    })

    expect(split.global).toEqual({
      experimental: {
        speech_to_text_model: "openai/gpt-4o-mini-transcribe",
      },
    })
    expect(split.project).toEqual({})
  })

  // raya_change - Milestone I model pins and routing survive the settings save boundary for future runs.
  it("writes agent model pins and routing settings to global config", () => {
    const split = splitConfigByScope({
      agent: { code: { model: "openai/gpt-4.1" } },
      small_model: "openai/gpt-4.1-mini",
      raya_routing: { confidence_threshold: 0.8, goal_continuation: true },
    })

    expect(split.global).toEqual({
      agent: { code: { model: "openai/gpt-4.1" } },
      small_model: "openai/gpt-4.1-mini",
      raya_routing: { confidence_threshold: 0.8, goal_continuation: true },
    })
    expect(split.project).toEqual({})
  })
})
