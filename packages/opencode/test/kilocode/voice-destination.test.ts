// raya_change - managed voice destinations are validated before session side effects
import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { local } from "@/kilocode/voice/destination"
import { RayaVoice } from "@/kilocode/voice/service"
import { SessionID } from "@/session/schema"
import type { Storage } from "@/storage/storage"

test("managed media destinations accept only numeric loopback HTTP origins", () => {
  expect(local("http://127.0.0.1:7890/")).toBe("http://127.0.0.1:7890")
  expect(local("http://127.1:80")).toBe("http://127.0.0.1")
  expect(local("http://[::1]:7890")).toBe("http://[::1]:7890")
  for (const value of [
    "https://127.0.0.1:7890",
    "http://localhost:7890",
    "http://127.evil.example:7890",
    "http://10.0.0.2:7890",
    "http://user:secret@127.0.0.1:7890",
    "http://127.0.0.1:7890/path",
    "http://127.0.0.1:7890?next=remote",
    "not a URL",
  ])
    expect(local(value)).toBeUndefined()
})

test("invalid media destinations fail before parent lookup or delegate creation", async () => {
  const unused = () => Effect.die("storage must not run")
  const storage: Storage.Interface = {
    create: unused,
    replace: unused,
    remove: unused,
    read: unused,
    update: unused,
    write: unused,
    list: unused,
  }
  const voice = RayaVoice.make({
    storage,
    sessions: {
      get: () => Effect.die("parent lookup must not run"),
      create: () => Effect.die("delegate creation must not run"),
    },
    prompts: {
      prompt: () => Effect.die("prompt must not run"),
      cancel: () => Effect.die("cancel must not run"),
    },
  })
  const exit = await Effect.runPromiseExit(
    voice.start({ parentSessionID: SessionID.make("ses_destination_test"), mediaURL: "http://media.example" }),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("RayaVoice.InputError")
  const key = await Effect.runPromiseExit(
    voice.start({
      parentSessionID: SessionID.make("ses_destination_test"),
      mediaURL: "http://127.0.0.1:7890",
    }),
  )
  expect(Exit.isFailure(key)).toBe(true)
  if (Exit.isFailure(key)) expect(key.cause.toString()).toContain("RayaVoice.InputError")
})
