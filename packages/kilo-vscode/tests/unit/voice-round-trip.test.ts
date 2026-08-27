// raya_change - Milestone H push-to-talk, hands-free, barge-in, and intelligence contracts
import { describe, expect, it } from "bun:test"
import { nextVoiceMode, voiceIntent } from "../../webview-ui/src/components/speech-to-text/voice-intent"
import { VoiceLoop } from "../../webview-ui/src/context/voice-loop"
import { VoiceEcho } from "../../webview-ui/src/context/voice-echo"
import { VoiceReplies } from "../../src/speech/replies"

describe("voice round trip", () => {
  // raya_change - prove the backend event sequence reaches the exact text handed to MiniMax
  it("collects a Voice assistant stream exactly once when the session becomes idle", () => {
    const replies = new VoiceReplies()
    replies.mark()
    replies.message("session-1", "user", "user-1")
    replies.message("session-1", "assistant", "assistant-1")
    replies.part("session-1", { id: "reasoning", messageID: "assistant-1", type: "reasoning", text: "hidden" })
    replies.part("session-1", {
      id: "snapshot",
      messageID: "assistant-1",
      type: "text",
      text: "⠋ Initializing snapshot…",
      synthetic: true,
    })
    replies.part("session-1", { id: "removed", messageID: "assistant-1", type: "text", text: "Temporary status." })
    replies.remove("session-1", "removed")
    replies.part("session-1", { id: "text-1", messageID: "assistant-1", type: "text", text: "Why did the robot " })
    replies.part("session-1", { id: "text-2", messageID: "assistant-1", type: "text", text: "cross the road?" })

    expect(replies.complete("another-session")).toBeUndefined()
    expect(replies.complete("session-1")).toBe("Why did the robot cross the road?")
    expect(replies.complete("session-1")).toBeUndefined()
  })

  // raya_change - backend status and synchronized part streams can settle a few milliseconds apart
  it("waits for final synchronized text that arrives just after idle", async () => {
    const replies = new VoiceReplies()
    replies.mark()
    const result = replies.wait("session-1", 500)
    setTimeout(() => {
      replies.message("session-1", "assistant", "assistant-1")
      replies.part("session-1", { id: "text-1", messageID: "assistant-1", type: "text", text: "Late final text." })
    }, 25)

    expect(await result).toBe("Late final text.")
  })

  it("cancels a pending spoken handoff when the orb stops", () => {
    const replies = new VoiceReplies()
    replies.mark()
    replies.message("session-1", "assistant", "assistant-1")
    replies.part("session-1", { id: "text-1", messageID: "assistant-1", type: "text", text: "Do not speak." })
    replies.cancel()
    expect(replies.complete("session-1")).toBeUndefined()
  })

  it("drops self-transcription and preserves new human words during double-talk", () => {
    const echo = new VoiceEcho()
    echo.set("Why did the robot cross the road? To recharge its batteries.")
    echo.interrupt(2)
    expect(echo.clean("Why did the robot cross the road to recharge its batteries")).toBeUndefined()
    expect(echo.take()).toBe("cross the road? To recharge its batteries.")
    echo.set("Why did the robot cross the road? To recharge its batteries.")
    echo.interrupt(2)
    expect(echo.clean("Why did the robot cross the road please stop and listen to me")).toBe(
      "please stop and listen to me",
    )
    expect(echo.take()).toBeUndefined()
    echo.set("Why did the robot cross the road? To recharge its batteries.")
    expect(echo.clean("cross the road to recharge batteries please stop now")).toBe("please stop now")
  })

  it("recognizes ordinary spoken requests to control voice mode", () => {
    expect(voiceIntent("Start a hands-free voice conversation")).toBe("hands-free")
    expect(voiceIntent("Switch to push to talk")).toBe("push-to-talk")
    expect(voiceIntent("Turn off voice mode")).toBe("off")
    expect(nextVoiceMode(nextVoiceMode(nextVoiceMode("off")))).toBe("off")
  })

  it("completes a push-to-talk turn and interrupts playback on speech", () => {
    const events = { listens: 0, stops: 0 }
    const loop = create(events)
    loop.set("push-to-talk")
    loop.listen()
    loop.wait()
    loop.speak()
    loop.done()
    expect(loop.state()).toEqual({ mode: "push-to-talk", phase: "idle" })
    expect(events.listens).toBe(0)

    loop.speak()
    loop.hear()
    expect(loop.state().phase).toBe("listening")
    expect(events.stops).toBe(1)
  })

  it("restarts listening after every hands-free reply and supports barge-in", () => {
    const events = { listens: 0, stops: 0 }
    const loop = create(events)
    loop.set("hands-free")
    expect(events.listens).toBe(1)
    loop.listen()
    loop.wait()
    loop.speak()
    loop.done()
    expect(events.listens).toBe(2)

    loop.listen()
    loop.speak()
    loop.hear()
    expect(loop.state()).toEqual({ mode: "hands-free", phase: "listening" })
    expect(events.stops).toBe(1)
  })
})

function create(events: { listens: number; stops: number }) {
  return new VoiceLoop({
    listen: () => events.listens++,
    stop: () => events.stops++,
  })
}
