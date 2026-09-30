import { describe, expect, it } from "bun:test"
import {
  NativeInputDispatchError,
  NativeInputHost,
  NativeInputPreflightError,
  type NativeInputDispatchIdentity,
} from "../../src/services/computer-use/desktop-input-host"

const action = {
  windowID: "0x123",
  observationID: "obs",
  sensitive: false as const,
  operation: "pointer" as const,
  action: "move" as const,
  x: 0.5,
  y: 0.5,
}
const target = {
  windowID: "0x123",
  identity: "A".repeat(64),
  location: "pid:42;title:Editor;bounds:0,0,100,100",
  scene: 1,
  observedAt: Date.now(),
  validUntil: Date.now() + 1000,
}

function child(mode: "normal" | "silent" | "partial" | "delayed" | "delayed_confirm" | "slow_hello") {
  return `
let buffer=Buffer.alloc(0);
process.stdin.on("data",chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length>=8){
    const size=buffer.readUInt32LE(0);
    if(buffer.length<size+8)return;
    const item=JSON.parse(buffer.subarray(4,size+4).toString("utf8"));
    buffer=buffer.subarray(size+8);
    if(${JSON.stringify(mode)}==="silent" && item.type==="dispatch")continue;
    const partial=${JSON.stringify(mode)}==="partial";
    const confirmed=${JSON.stringify(mode)}==="delayed_confirm";
    const type=item.type==="hello"?"ready":item.type==="dispatch"?(partial?"unknown":confirmed?"confirmed":"refused"):item.type==="cancel"?"cancelled":(partial?"unknown":"quiescent");
    const code=item.type==="dispatch"?(partial?"partial":confirmed?"ok":"unsupported"):item.type==="quiescent"&&partial?"partial":item.type==="cancel"?"in_flight":"ok";
    const value={v:2,type,session:item.session,request:item.request,sequence:item.sequence,code,accepted:item.type==="dispatch"&&(partial||confirmed)?1:0,attempted:item.type==="dispatch"?partial?2:confirmed?1:0:0};
    const body=Buffer.from(JSON.stringify(value));
    const packet=Buffer.alloc(body.length+8);
    packet.writeUInt32LE(body.length,0);
    body.copy(packet,4);
    packet.writeUInt32LE(0,body.length+4);
    if(((${JSON.stringify(mode)}==="delayed"||${JSON.stringify(mode)}==="delayed_confirm") && item.type==="dispatch")||(${JSON.stringify(mode)}==="slow_hello" && item.type==="hello"))setTimeout(()=>process.stdout.write(packet),150);
    else process.stdout.write(packet);
  }
});
`
}

function stop(host: NativeInputHost) {
  ;(host as unknown as { child?: { kill: () => void } }).child?.kill()
}

describe("native input broker host", () => {
  it("rechecks authority after a held reservation without writing rejected input", async () => {
    const host = new NativeInputHost("node", ["-e", child("normal")])
    await host.start()
    const hold: { release?: () => void } = {}
    const gate = new Promise<void>((resolve) => {
      hold.release = resolve
    })
    let allowed = true
    const pending = host.dispatch(
      action,
      target,
      () => gate,
      () => {
        if (!allowed) throw new Error("grant expired")
      },
    )
    allowed = false
    hold.release?.()
    await expect(pending).rejects.toBeInstanceOf(NativeInputPreflightError)
    expect((host as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    expect(await host.dispatch(action, target)).toMatchObject({ type: "refused", code: "unsupported" })
    await host.cancel()
    host.close()
  })

  it("treats pre-send validation failures as typed and leaves the broker usable", async () => {
    const host = new NativeInputHost("node", ["-e", child("normal")])
    await host.start()
    const prepared: NativeInputDispatchIdentity[] = []
    await expect(
      host.dispatch(action, { ...target, windowID: "0x124" }, (item) => prepared.push(item)),
    ).rejects.toBeInstanceOf(NativeInputPreflightError)
    await expect(host.dispatch({ ...action, x: 1.1 }, target, (item) => prepared.push(item))).rejects.toBeInstanceOf(
      NativeInputPreflightError,
    )
    const windowID = `0x${"1".repeat(4_096)}`
    await expect(
      host.dispatch({ ...action, windowID }, { ...target, windowID }, (item) => prepared.push(item)),
    ).rejects.toBeInstanceOf(NativeInputPreflightError)
    expect(prepared).toEqual([])
    expect(await host.dispatch(action, target)).toMatchObject({ type: "refused", code: "unsupported" })
    await host.cancel()
    host.close()
  })

  it("closes safely when cancelled before startup without launching a broker", async () => {
    const host = new NativeInputHost("node", ["-e", child("normal")])
    await host.cancel()
    expect(host.canClose).toBe(true)
    await expect(host.start()).rejects.toBeInstanceOf(NativeInputPreflightError)
    host.close()
  })

  it("seals dispatch while startup hello is pending, then cancels the bound broker", async () => {
    const host = new NativeInputHost("node", ["-e", child("slow_hello")])
    const starting = host.start()
    const stopping = host.cancel()
    await expect(host.dispatch(action, target)).rejects.toBeInstanceOf(NativeInputPreflightError)
    await expect(starting).rejects.toBeInstanceOf(NativeInputPreflightError)
    await stopping
    expect(host.canClose).toBe(true)
    host.close()
  })

  it("binds a session, refuses unimplemented dispatch, and acknowledges cancellation", async () => {
    const host = new NativeInputHost("node", ["-e", child("normal")])
    await host.start()
    const prepared: NativeInputDispatchIdentity[] = []
    const reply = await host.dispatch(action, target, (item) => prepared.push(item))
    expect(reply).toMatchObject({
      type: "refused",
      code: "unsupported",
    })
    expect(prepared).toEqual([{ session: reply.session, request: reply.request, sequence: reply.sequence }])
    await host.cancel()
    expect(host.canClose).toBe(true)
    await expect(host.dispatch(action, { ...target, scene: 2 })).rejects.toThrow(/not ready/i)
    host.close()
  })

  it("waits for the host binding before writing and leaves a rejected binding unsent", async () => {
    const host = new NativeInputHost("node", ["-e", child("normal")])
    await host.start()
    const prepared: NativeInputDispatchIdentity[] = []
    const pending = host.dispatch(action, target, async (item) => {
      prepared.push(item)
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(prepared).toHaveLength(1)
    expect((host as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    await expect(host.dispatch(action, target)).rejects.toBeInstanceOf(NativeInputPreflightError)
    const reply = await pending
    expect(reply.request).toBe(prepared[0].request)
    const rejected = await host
      .dispatch(action, { ...target, scene: 2 }, async () => {
        throw new Error("journal unavailable")
      })
      .catch((value: unknown) => value)
    expect(rejected).toBeInstanceOf(NativeInputPreflightError)
    expect(rejected).not.toHaveProperty("identity")
    expect((host as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    expect(await host.dispatch(action, { ...target, scene: 3 })).toMatchObject({ type: "refused" })
    await host.cancel()
    host.close()
  })

  it("treats a cancelled async binding as a certain no-send", async () => {
    const host = new NativeInputHost("node", ["-e", child("normal")])
    await host.start()
    const hold: { release?: () => void } = {}
    const gate = new Promise<void>((resolve) => {
      hold.release = resolve
    })
    const prepared: NativeInputDispatchIdentity[] = []
    const pending = host.dispatch(action, target, (item) => {
      prepared.push(item)
      return gate
    })
    expect(prepared).toHaveLength(1)
    expect((host as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    const stopping = host.cancel()
    hold.release?.()
    const error = await pending.catch((value: unknown) => value)
    expect(error).toBeInstanceOf(NativeInputPreflightError)
    expect(error).not.toHaveProperty("identity")
    await stopping
    expect(host.canClose).toBe(true)
    host.close()
  })

  it("awaits a thenable binding before sending", async () => {
    const host = new NativeInputHost("node", ["-e", child("normal")])
    await host.start()
    const hold: { release?: () => void } = {}
    const gate = new Promise<void>((resolve) => {
      hold.release = resolve
    })
    const pending = host.dispatch(action, target, () => ({ then: gate.then.bind(gate) }))
    expect((host as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    hold.release?.()
    expect(await pending).toMatchObject({ type: "refused", code: "unsupported" })
    await host.cancel()
    host.close()
  })

  it("rejects a stale response and revokes the local broker session", async () => {
    const host = new NativeInputHost("node", ["-e", child("silent")])
    await host.start()
    const pending = host.dispatch(action, target)
    const internals = host as unknown as {
      session: string
      pending: Map<string, { sequence: number }>
      read: (packet: Buffer) => void
    }
    const [request, active] = [...internals.pending][0]
    const body = Buffer.from(
      JSON.stringify({
        v: 2,
        type: "refused",
        session: internals.session,
        request,
        sequence: active.sequence + 1,
        code: "unsupported",
        accepted: 0,
        attempted: 0,
      }),
    )
    const packet = Buffer.alloc(body.length + 8)
    packet.writeUInt32LE(body.length, 0)
    body.copy(packet, 4)
    internals.read(packet)
    await expect(pending).rejects.toThrow(/stale reply/i)
    await expect(host.dispatch(action, { ...target, scene: 2 })).rejects.toThrow(/not ready/i)
    expect(host.canClose).toBe(false)
    expect(() => host.close()).toThrow(/cannot close/i)
    stop(host)
  })

  it("reports unknown outcome on process loss without replay", async () => {
    const host = new NativeInputHost("node", ["-e", child("silent")])
    await host.start()
    const prepared: NativeInputDispatchIdentity[] = []
    const pending = host.dispatch(action, target, (item) => prepared.push(item))
    const broker = (host as unknown as { child: { emit: (event: string, code: number) => void } }).child
    stop(host)
    broker.emit("close", 12)
    const error = await pending.catch((value: unknown) => value)
    expect(error).toBeInstanceOf(NativeInputDispatchError)
    expect(error).toMatchObject({ identity: prepared[0], outcome: "unknown" })
    expect(error.message).toMatch(/outcome is unknown/i)
    await expect(host.dispatch(action, { ...target, scene: 2 })).rejects.toThrow(/not ready/i)
  })

  it("blocks later dispatch after a partially accepted input batch", async () => {
    const host = new NativeInputHost("node", ["-e", child("partial")])
    await host.start()
    expect(await host.dispatch(action, target)).toMatchObject({
      type: "unknown",
      code: "partial",
      accepted: 1,
      attempted: 2,
    })
    await expect(host.dispatch(action, { ...target, scene: 2 })).rejects.toThrow(/not ready/i)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(host.cancel()).rejects.toThrow(/quiescence/i)
    expect(host.canClose).toBe(false)
    expect(() => host.close()).toThrow(/cannot close/i)
    stop(host)
  })

  it("seals input immediately on cancellation and waits for the original dispatch receipt", async () => {
    const host = new NativeInputHost("node", ["-e", child("delayed")])
    await host.start()
    const pending = host.dispatch(action, target)
    const stopping = host.cancel()
    await expect(host.dispatch(action, { ...target, scene: 2 })).rejects.toThrow(/not ready/i)
    await stopping
    expect(host.canClose).toBe(true)
    expect(await pending).toMatchObject({ type: "refused", code: "unsupported" })
    host.close()
  })

  it("does not finish cancellation before a confirmed in-flight receipt arrives", async () => {
    const host = new NativeInputHost("node", ["-e", child("delayed_confirm")])
    await host.start()
    const prepared: NativeInputDispatchIdentity[] = []
    const pending = host.dispatch(action, target, (item) => prepared.push(item))
    const stopping = host.cancel()
    await stopping
    expect(host.canClose).toBe(true)
    const reply = await pending
    expect(reply).toMatchObject({ type: "confirmed", code: "ok", accepted: 1, attempted: 1 })
    expect(prepared).toEqual([{ session: reply.session, request: reply.request, sequence: reply.sequence }])
    host.close()
  })

  it("keeps a lost dispatch reply unknown even after cancellation and quiescence", async () => {
    const host = new NativeInputHost("node", ["-e", child("silent")], 2_000)
    await host.start()
    const pending = host.dispatch(action, target)
    await expect(host.dispatch(action, { ...target, scene: 2 })).rejects.toThrow(/in flight/i)
    await expect(pending).rejects.toThrow(/outcome is unknown/i)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(host.cancel()).rejects.toThrow(/outcome is unknown/i)
    expect(host.canClose).toBe(false)
    await expect(host.dispatch(action, { ...target, scene: 3 })).rejects.toThrow(/not ready/i)
    expect(() => host.close()).toThrow(/cannot close/i)
    stop(host)
  })

  it("retains the prepared identity when a dispatch response times out", async () => {
    const host = new NativeInputHost("node", ["-e", child("silent")], 1_000)
    await host.start()
    const prepared: NativeInputDispatchIdentity[] = []
    const error = await host.dispatch(action, target, (item) => prepared.push(item)).catch((value: unknown) => value)
    expect(prepared).toHaveLength(1)
    expect(error).toBeInstanceOf(NativeInputDispatchError)
    expect(error).toMatchObject({ identity: prepared[0], outcome: "unknown" })
    expect(error.message).toMatch(/timed out/i)
    await expect(host.dispatch(action, { ...target, scene: 2 })).rejects.toBeInstanceOf(NativeInputPreflightError)
    stop(host)
  })
})
