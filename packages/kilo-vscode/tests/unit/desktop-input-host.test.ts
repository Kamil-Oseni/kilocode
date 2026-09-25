import { describe, expect, it } from "bun:test"
import { NativeInputHost } from "../../src/services/computer-use/desktop-input-host"

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

function child(mode: "normal" | "silent" | "partial") {
  return `
let buffer=Buffer.alloc(0);
process.stdin.on("data",chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length>=8){
    const size=buffer.readUInt32LE(0);
    if(buffer.length<size+8)return;
    const item=JSON.parse(buffer.subarray(4,size+4).toString("utf8"));
    buffer=buffer.subarray(size+8);
    if(${JSON.stringify(mode)}==="silent" && item.type==="dispatch")return;
    const partial=${JSON.stringify(mode)}==="partial";
    const type=item.type==="hello"?"ready":item.type==="dispatch"?(partial?"unknown":"refused"):item.type==="cancel"?"cancelled":(partial?"unknown":"quiescent");
    const code=item.type==="dispatch"?(partial?"partial":"unsupported"):item.type==="quiescent"&&partial?"partial":item.type==="cancel"?"in_flight":"ok";
    const value={v:2,type,session:item.session,request:item.request,sequence:item.sequence,code,accepted:item.type==="dispatch"&&partial?1:0,attempted:item.type==="dispatch"&&partial?2:0};
    const body=Buffer.from(JSON.stringify(value));
    const packet=Buffer.alloc(body.length+8);
    packet.writeUInt32LE(body.length,0);
    body.copy(packet,4);
    packet.writeUInt32LE(0,body.length+4);
    process.stdout.write(packet);
  }
});
`
}

describe("native input broker host", () => {
  it("binds a session, refuses unimplemented dispatch, and acknowledges cancellation", async () => {
    const host = new NativeInputHost("node", ["-e", child("normal")])
    await host.start()
    expect(await host.dispatch(action, target)).toMatchObject({
      type: "refused",
      code: "unsupported",
    })
    await host.cancel()
    await expect(host.dispatch(action, { ...target, scene: 2 })).rejects.toThrow(/not ready/i)
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
  })

  it("reports unknown outcome on process loss without replay", async () => {
    const host = new NativeInputHost("node", ["-e", child("silent")])
    await host.start()
    const pending = host.dispatch(action, target)
    ;(host as unknown as { child: { emit: (event: string, code: number) => void } }).child.emit("close", 12)
    await expect(pending).rejects.toThrow(/outcome is unknown/i)
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
    host.close()
  })
})
