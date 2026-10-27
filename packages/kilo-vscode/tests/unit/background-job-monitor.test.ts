import { expect, test } from "bun:test"
import { createBackgroundMonitor } from "../../webview-ui/src/components/chat/background-job-monitor"
import type { ExtensionMessage, WebviewMessage, BackgroundJobInfo } from "../../webview-ui/src/types/messages"

test("Task monitor invalidation coalesces exact current children and preserves Stop and scope ownership", async () => {
  const sent: WebviewMessage[] = []
  const listeners = new Set<(message: ExtensionMessage) => void>()
  let scope: { sessionID: string; directory: string } | undefined = { sessionID: "ses_parent", directory: "C:/first" }
  const states: Parameters<Parameters<typeof createBackgroundMonitor>[0]["update"]>[0][] = []
  const monitor = createBackgroundMonitor({
    scope: () => scope,
    post: (message) => sent.push(message),
    listen: (handler) => {
      listeners.add(handler)
      return () => {
        listeners.delete(handler)
      }
    },
    update: (state) => states.push(state),
  })
  const emit = (message: ExtensionMessage) => {
    for (const listener of listeners) listener(message)
  }
  const request = () => {
    const message = sent.at(-1)
    if (message?.type !== "requestBackgroundJobs") throw new Error("Expected an actual background job request")
    return message
  }
  const job: BackgroundJobInfo = {
    id: "job_original",
    type: "task",
    status: "running",
    revision: "original",
    started_at: 1,
    metadata: {
      parentSessionId: "ses_parent",
      sessionId: "ses_child",
      background: true,
      localInference: { queued: true },
    },
  }
  const reply = (id: string, jobs = [job]) =>
    emit({ type: "backgroundJobsLoaded", sessionID: "ses_parent", requestID: id, jobs })
  try {
    monitor.reset()
    monitor.request()
    expect(sent).toHaveLength(1)
    reply(request().requestID)
    expect(states.at(-1)?.snapshot.jobs).toEqual([job])
    emit({ type: "localInferenceChanged", sessionID: "ses_foreign" })
    expect(sent).toHaveLength(1)
    emit({ type: "localInferenceChanged", sessionID: "ses_child" })
    expect(sent).toHaveLength(2)
    expect(states.at(-1)?.snapshot.jobs[0]?.metadata?.localInference).toBeUndefined()
    const held = request().requestID
    emit({ type: "localInferenceChanged", sessionID: "ses_child" })
    emit({ type: "localInferenceChanged", sessionID: "ses_parent" })
    expect(sent).toHaveLength(2)
    reply(held)
    expect(sent).toHaveLength(3)
    expect(request().requestID).not.toBe(held)
    expect(states.at(-1)?.snapshot.jobs[0]?.metadata?.localInference).toBeUndefined()
    reply(held)
    expect(sent).toHaveLength(3)
    reply(request().requestID)
    expect(states.at(-1)?.snapshot.jobs).toEqual([job])
    monitor.stop({ id: job.id, revision: "original", request: "stop_original" })
    emit({ type: "localInferenceChanged", sessionID: "ses_child" })
    const observed = request().requestID
    expect(states.at(-1)?.stop?.request).toBe("stop_original")
    reply("stop_original", [{ ...job, status: "cancelled", revision: "cancelled" }])
    expect(states.at(-1)?.stop).toBeUndefined()
    expect(states.at(-1)?.snapshot.jobs[0]?.status).toBe("cancelled")
    reply(observed)
    expect(states.at(-1)?.snapshot.jobs[0]?.status).toBe("cancelled")
    const count = sent.length
    emit({ type: "localInferenceChanged", sessionID: "ses_child" })
    expect(sent).toHaveLength(count)
    emit({ type: "localInferenceChanged", sessionID: "ses_parent" })
    const departed = request().requestID
    scope = { sessionID: "ses_parent", directory: "C:/second" }
    monitor.reset()
    scope = { sessionID: "ses_parent", directory: "C:/first" }
    monitor.reset()
    reply(departed)
    expect(states.at(-1)?.snapshot.loaded).toBe(false)
    monitor.request()
    const disconnected = request().requestID
    scope = undefined
    emit({ type: "connectionState", state: "disconnected" })
    reply(disconnected)
    expect(states.at(-1)?.snapshot.loaded).toBe(false)
    await Promise.resolve()
    const offline = sent.length
    emit({ type: "localInferenceChanged", sessionID: "ses_parent" })
    expect(sent).toHaveLength(offline)
    scope = { sessionID: "ses_parent", directory: "C:/first" }
    emit({ type: "connectionState", state: "connected" })
    await Promise.resolve()
    expect(sent).toHaveLength(offline + 1)
    reply(request().requestID)
    expect(states.at(-1)?.snapshot.loaded).toBe(true)
    monitor.dispose()
    emit({ type: "localInferenceChanged", sessionID: "ses_parent" })
    expect(listeners.size).toBe(0)
    expect(sent).toHaveLength(offline + 1)
  } finally {
    monitor.dispose()
  }
})
