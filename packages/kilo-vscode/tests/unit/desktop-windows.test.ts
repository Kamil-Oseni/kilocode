import { describe, expect, it } from "bun:test"
import { WindowsDesktopDriver } from "../../src/services/computer-use/desktop-windows"
import type { DesktopCaptureWorker } from "../../src/services/computer-use/desktop-capture-worker"

function harness(outputs: string[]) {
  const scripts: string[] = []
  let cancelled = 0
  return {
    scripts,
    cancelled: () => cancelled,
    runner: {
      run: async (script: string) => {
        scripts.push(script)
        return outputs.shift() ?? ""
      },
      cancel: () => {
        cancelled += 1
      },
    },
  }
}

describe("Windows native desktop driver", () => {
  it("refuses warm native pixels after same-handle replacement and falls back on an app switch", async () => {
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,20,10" }
    const identity = "A".repeat(64)
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const header = {
      v: 3,
      type: "frame",
      epoch: 1,
      sequence: 1,
      ...target,
      identity,
      width: 20,
      height: 10,
      mime: "image/png",
      acquisitionMs: 1,
      preparationMs: 1,
    }
    const json = Buffer.from(JSON.stringify(header))
    const packet = Buffer.alloc(8 + json.length + image.length)
    packet.writeUInt32LE(json.length, 0)
    json.copy(packet, 4)
    packet.writeUInt32LE(image.length, 4 + json.length)
    image.copy(packet, 8 + json.length)
    const script = `process.stdout.write(Buffer.from(${JSON.stringify(packet.toString("base64"))},"base64"));setInterval(()=>{},1000)`
    for (const current of [
      { ...target, identity },
      { ...target, identity: "B".repeat(64) },
      { windowID: "0x456", location: "pid:6;title:Browser;bounds:0,0,20,10", identity: "B".repeat(64) },
    ]) {
      const calls: string[] = []
      const driver = new WindowsDesktopDriver(
        {
          run: async (value) => {
            calls.push(value)
            if (value.includes("[RayaDesktopNative]::Identity($window.Handle)")) return JSON.stringify(current)
            if (value.includes("CopyFromScreen"))
              return JSON.stringify({
                windowID: current.windowID,
                location: current.location,
                width: 20,
                height: 10,
                mime: "image/png",
                data: "fresh pixels",
                acquisitionMs: 0,
                preparationMs: 0,
              })
            return JSON.stringify(current)
          },
          cancel: () => undefined,
        },
        undefined,
        process.execPath,
        ["-e", script],
      )
      const errors: unknown[] = []
      const latest = () => (Reflect.get(driver, "worker") as DesktopCaptureWorker | undefined)?.latest()
      driver.startCapture((error) => errors.push(error))
      try {
        for (let index = 0; index < 100 && !latest(); index++) await Bun.sleep(2)
        expect(latest()?.sourceIdentity).toBe(identity)
        expect((await driver.observe({ semantics: false })).data).toBe(
          current.identity === identity ? image.toString("base64") : "fresh pixels",
        )
        expect(calls.filter((value) => value.includes("[RayaDesktopNative]::Identity($window.Handle)"))).toHaveLength(1)
        expect(calls.filter((value) => value.includes("CopyFromScreen"))).toHaveLength(
          current.identity === identity ? 0 : 1,
        )
        expect(errors).toHaveLength(0)
      } finally {
        driver.stopCapture()
      }
    }
  })

  it("retains only the selected window across foreground changes and rejects a reused identity", async () => {
    const identity = "A".repeat(64)
    const chosen = { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,20,10" }
    const other = { windowID: "0x456", location: "pid:6;title:Other;bounds:0,0,20,10" }
    const state = { window: chosen, identity }
    let samples = 0
    let direct = 0
    const image = (target: typeof chosen, data: string) =>
      JSON.stringify({
        ...target,
        width: 20,
        height: 10,
        mime: "image/png",
        data,
        acquisitionMs: 0,
        preparationMs: 0,
      })
    const primary = {
      run: async (script: string) => {
        if (script.includes("[RayaDesktopNative]::Identity($value)"))
          return JSON.stringify({ identity: state.identity })
        if (script.includes("Desktop target changed after post-action capture"))
          return JSON.stringify({ ...state.window, identity: state.identity })
        if (script.includes("CopyFromScreen")) {
          direct++
          return image(state.window, "direct")
        }
        return JSON.stringify(state.window)
      },
      cancel: () => undefined,
    }
    const background = {
      run: async () => {
        samples++
        if (samples === 1) return image(chosen, "first")
        if (samples === 2) return image(other, "private")
        if (samples === 3) return image(chosen, "reused")
        if (samples === 4) return image(chosen, "returned")
        return new Promise<string>(() => undefined)
      },
      cancel: () => undefined,
    }
    const driver = new WindowsDesktopDriver(primary, background, "not-a-native-binary")
    const errors: unknown[] = []
    const latest = () => (Reflect.get(driver, "worker") as DesktopCaptureWorker | undefined)?.latest()
    driver.startCapture((error) => errors.push(error), { windowID: chosen.windowID, identity })
    try {
      for (let index = 0; index < 100 && latest()?.frame.data !== "first"; index++) await Bun.sleep(2)
      expect(latest()?.frame.data).toBe("first")
      expect(errors).toHaveLength(0)
      state.window = other
      for (let index = 0; index < 100 && samples < 2; index++) await Bun.sleep(2)
      for (let index = 0; index < 100 && latest(); index++) await Bun.sleep(2)
      expect(latest()).toBeUndefined()
      await expect(driver.observe({ semantics: false })).rejects.toThrow(
        /(selected desktop window|desktop target) changed/i,
      )
      state.window = chosen
      state.identity = "B".repeat(64)
      for (let index = 0; index < 100 && samples < 3; index++) await Bun.sleep(2)
      expect(latest()).toBeUndefined()
      await expect(driver.observe({ semantics: false })).rejects.toThrow(
        /(selected desktop window|desktop target) changed/i,
      )
      state.identity = identity
      for (let index = 0; index < 100 && latest()?.frame.data !== "returned"; index++) await Bun.sleep(2)
      expect(latest()?.frame.data).toBe("returned")
      expect((await driver.observe({ semantics: false })).data).toBe("returned")
      expect(direct).toBe(2)
      expect(errors).toHaveLength(0)
    } finally {
      driver.stopCapture()
    }
  }, 15_000)

  it("binds only the foreground window to a verifiable incarnation", async () => {
    const identity = "A".repeat(64)
    const target = { windowID: "0x123", title: "Editor", identity }
    const scripts: string[] = []
    const driver = new WindowsDesktopDriver({
      run: async (script) => {
        scripts.push(script)
        return JSON.stringify(target)
      },
      cancel: () => undefined,
    })

    expect(await driver.pinCurrent(target.windowID)).toEqual(target)
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain("PinForeground($window.Handle.ToInt64())")
    expect(scripts[0]).toContain("Selected desktop window is no longer foreground")
    expect(scripts[0]).toContain("Selected desktop window changed while binding its identity")
    expect(scripts[0]).toContain("SetProp(handle, InstanceProperty, instance)")
    expect(scripts[0]).toContain(";instance:")

    const changed = new WindowsDesktopDriver({
      run: async () => JSON.stringify({ ...target, windowID: "0x456" }),
      cancel: () => undefined,
    })
    await expect(changed.pinCurrent(target.windowID)).rejects.toThrow(/binding is incomplete/i)
  })

  it("uses a request-matched native post-action image and correlates exact UI Automation", async () => {
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,20,10" }
    const identity = "A".repeat(64)
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const next = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2])
    const header = {
      v: 1,
      type: "frame",
      sequence: 1,
      ...target,
      width: 20,
      height: 10,
      mime: "image/png",
      acquisitionMs: 1,
      preparationMs: 1,
    }
    const script = `
      const h=${JSON.stringify(header)};
      const send=(meta,data)=>{const json=Buffer.from(JSON.stringify(meta));const packet=Buffer.alloc(8+json.length+data.length);packet.writeUInt32LE(json.length,0);json.copy(packet,4);packet.writeUInt32LE(data.length,4+json.length);data.copy(packet,8+json.length);process.stdout.write(packet)};
      send(h,Buffer.from(${JSON.stringify(image.toString("base64"))},"base64"));
      process.stdin.once("data",b=>send({...h,v:2,sequence:2,request:b.toString("ascii",52,84),scene:Number(b.readBigUInt64LE(8)),source:Number(b.readBigUInt64LE(16)),receiptQpc:"100",presentQpc:"101"},Buffer.from(${JSON.stringify(next.toString("base64"))},"base64")));
      setInterval(()=>{},1000);
    `
    const semantics = {
      source: "windows_ui_automation",
      status: "available",
      viewport: { x: 0, y: 0, width: 20, height: 10 },
      controls: [],
      truncated: false,
    }
    const calls: string[] = []
    const runner = {
      run: async (value: string) => {
        calls.push(value)
        if (value.includes("CopyFromScreen"))
          return JSON.stringify({
            ...target,
            width: 20,
            height: 10,
            mime: "image/png",
            data: "fallback",
            semantics,
            semanticsMs: 0,
            acquisitionMs: 0,
            preparationMs: 0,
          })
        if (value.includes("Foreground window changed before semantic observation"))
          return JSON.stringify({ ...target, identity, semantics, semanticsMs: 1 })
        if (value.includes("[RayaDesktopNative]::Identity($value)")) return JSON.stringify({ identity })
        return JSON.stringify(target)
      },
      cancel: () => undefined,
    }
    const driver = new WindowsDesktopDriver(runner, undefined, process.execPath, ["-e", script])
    const errors: unknown[] = []
    driver.startCapture((error) => errors.push(error))
    try {
      let captured = ""
      for (let index = 0; index < 100 && captured !== image.toString("base64"); index++) {
        captured = (await driver.observe({ semantics: false })).data
        await Bun.sleep(5)
      }
      expect(captured).toBe(image.toString("base64"))
      const prior = calls.filter((value) => value.includes("CopyFromScreen")).length
      const result = await driver.observeAfter({ ...target, identity, scene: 7, observedAt: 1, validUntil: 10_000 })
      expect(result.data).toBe(next.toString("base64"))
      expect(result.semantics).toMatchObject({ status: "available" })
      expect(result.timing.acquisitionMs).toBe(1)
      expect(result.timing.preparationMs).toBeLessThan(result.timing.totalMs)
      expect(calls.filter((value) => value.includes("CopyFromScreen"))).toHaveLength(prior)
      expect(
        calls.filter((value) => value.includes("Foreground window changed before semantic observation")),
      ).toHaveLength(1)
      expect(calls.filter((value) => value.includes("[RayaDesktopNative]::Identity($value)"))).toHaveLength(0)
      expect(errors).toHaveLength(0)
    } finally {
      driver.stopCapture()
    }
  })

  it("falls back only for a bounded no-present refusal, and stops on a changed target or process", async () => {
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,20,10" }
    const header = {
      v: 1,
      type: "frame",
      sequence: 1,
      ...target,
      width: 20,
      height: 10,
      mime: "image/png",
      acquisitionMs: 1,
      preparationMs: 1,
    }
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    for (const [reason, changed] of [
      ["no_present", false],
      ["no_present", true],
      ["target_changed", false],
    ] as const) {
      const script = `
        const h=${JSON.stringify(header)};
        const send=(meta,data)=>{const json=Buffer.from(JSON.stringify(meta));const packet=Buffer.alloc(8+json.length+data.length);packet.writeUInt32LE(json.length,0);json.copy(packet,4);packet.writeUInt32LE(data.length,4+json.length);data.copy(packet,8+json.length);process.stdout.write(packet)};
        send(h,Buffer.from(${JSON.stringify(image.toString("base64"))},"base64"));
        process.stdin.once("data",b=>send({v:2,type:"barrier",status:"unproven",reason:${JSON.stringify(reason)},request:b.toString("ascii",52,84),scene:Number(b.readBigUInt64LE(8)),source:Number(b.readBigUInt64LE(16)),receiptQpc:"100"},Buffer.alloc(0)));
        setInterval(()=>{},1000);
      `
      const calls: string[] = []
      const runner = {
        run: async (value: string) => {
          calls.push(value)
          if (value.includes("CopyFromScreen"))
            return JSON.stringify({
              ...target,
              width: 20,
              height: 10,
              mime: "image/png",
              data: "fresh PowerShell pixels",
              acquisitionMs: 0,
              preparationMs: 0,
            })
          if (value.includes("[RayaDesktopNative]::Identity($value)"))
            return JSON.stringify({ identity: "A".repeat(64) })
          if (value.includes("Desktop target changed after post-action capture"))
            return JSON.stringify({ ...target, identity: (changed ? "B" : "A").repeat(64) })
          return JSON.stringify(target)
        },
        cancel: () => undefined,
      }
      const driver = new WindowsDesktopDriver(runner, undefined, process.execPath, ["-e", script])
      const errors: unknown[] = []
      driver.startCapture((error) => errors.push(error))
      try {
        let captured = ""
        for (let index = 0; index < 100 && captured !== image.toString("base64"); index++) {
          captured = (await driver.observe({ semantics: false })).data
          await Bun.sleep(5)
        }
        expect(captured).toBe(image.toString("base64"))
        const prior = calls.filter((value) => value.includes("CopyFromScreen")).length
        const pending = driver.observeAfter({
          ...target,
          identity: "A".repeat(64),
          scene: 7,
          observedAt: 1,
          validUntil: 10_000,
        })
        if (reason === "no_present" && !changed) {
          expect((await pending).data).toBe("fresh PowerShell pixels")
          expect(calls.filter((value) => value.includes("CopyFromScreen"))).toHaveLength(prior + 1)
          expect(
            calls.filter((value) => value.includes("Desktop target changed after post-action capture")),
          ).toHaveLength(1)
          expect(calls.filter((value) => value.includes("[RayaDesktopNative]::Identity($value)"))).toHaveLength(0)
        } else if (changed) {
          await expect(pending).rejects.toThrow(/target changed after post-action capture/i)
          expect(calls.filter((value) => value.includes("CopyFromScreen"))).toHaveLength(prior + 1)
        } else {
          await expect(pending).rejects.toThrow(/target_changed/)
          expect(calls.filter((value) => value.includes("CopyFromScreen"))).toHaveLength(prior)
        }
        expect(errors).toHaveLength(0)
      } finally {
        driver.stopCapture()
      }
    }
  })

  it("joins a real binary child frame only for the exact foreground and stops its stream", async () => {
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,20,10" }
    const header = {
      v: 1,
      type: "frame",
      sequence: 1,
      ...target,
      width: 20,
      height: 10,
      mime: "image/png",
      acquisitionMs: 2,
      preparationMs: 3,
    }
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const script = `
      const h=${JSON.stringify(header)};
      const image=Buffer.from(${JSON.stringify(image.toString("base64"))},"base64");
      const send=(meta,data)=>{const json=Buffer.from(JSON.stringify(meta));const packet=Buffer.alloc(8+json.length+data.length);packet.writeUInt32LE(json.length,0);json.copy(packet,4);packet.writeUInt32LE(data.length,4+json.length);data.copy(packet,8+json.length);process.stdout.write(packet)};
      send(h,image);
      setInterval(()=>send({v:1,type:"unchanged",sequence:++h.sequence,base:1,windowID:h.windowID,location:h.location,width:h.width,height:h.height},Buffer.alloc(0)),25);
    `
    const scripts: string[] = []
    let moved = false
    const primary = {
      run: async (value: string) => {
        scripts.push(value)
        const current = moved ? { ...target, location: "pid:5;title:Editor;bounds:1,0,20,10" } : target
        if (!value.includes("CopyFromScreen")) return JSON.stringify(current)
        return JSON.stringify({
          ...current,
          width: 20,
          height: 10,
          mime: "image/png",
          data: "fallback",
          acquisitionMs: 0,
          preparationMs: 0,
        })
      },
      cancel: () => undefined,
    }
    const driver = new WindowsDesktopDriver(primary, undefined, process.execPath, ["-e", script])
    const errors: unknown[] = []
    driver.startCapture((error) => errors.push(error))
    let data = ""
    for (let index = 0; index < 200 && data !== image.toString("base64"); index++) {
      data = (await driver.observe({ semantics: false })).data
      await Bun.sleep(5)
    }
    expect(data).toBe(image.toString("base64"))
    const before = scripts.filter((value) => value.includes("CopyFromScreen")).length
    await Bun.sleep(200)
    expect((await driver.observe({ semantics: false })).data).toBe(image.toString("base64"))
    expect(scripts.filter((value) => value.includes("CopyFromScreen"))).toHaveLength(before)
    moved = true
    expect((await driver.observe({ semantics: false })).data).toBe("fallback")
    driver.stopCapture()
    expect(errors).toHaveLength(0)
    expect(scripts.some((value) => value.includes("CopyFromScreen"))).toBe(true)
  })
  it("collects UI Automation against an exact foreground target without capturing pixels", async () => {
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:10,20,1280,720" }
    const test = harness([
      JSON.stringify({
        ...target,
        semanticsMs: 12,
        semantics: {
          source: "windows_ui_automation",
          status: "available",
          viewport: { x: 10, y: 20, width: 1280, height: 720 },
          controls: [
            {
              controlID: "42.7",
              role: "Button",
              name: "Save",
              x: 100,
              y: 80,
              width: 64,
              height: 28,
              enabled: true,
              focused: false,
              actions: ["invoke"],
            },
          ],
          truncated: false,
        },
      }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    expect(await driver.observeSemantics(target)).toEqual({
      ...target,
      semanticsMs: 12,
      semantics: expect.objectContaining({
        status: "available",
        controls: [expect.objectContaining({ controlID: "42.7", name: "Save" })],
      }),
    })
    expect(test.scripts[0]).toContain("Get-RayaControls $window")
    expect(test.scripts[0]).toContain("Foreground window changed before semantic observation")
    expect(test.scripts[0]).toContain("Foreground window changed while correlating semantic observations")
    expect(test.scripts[0]).toContain(Buffer.from(JSON.stringify(target), "utf8").toString("base64"))
    expect(test.scripts[0]).not.toContain("CopyFromScreen")
    expect(test.scripts[0]).not.toContain("Drawing.Bitmap")
    expect(test.scripts[0]).not.toContain("ToBase64String($stream")
  })

  it("accepts explicitly unavailable UI Automation without inventing controls", async () => {
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:10,20,1280,720" }
    const test = harness([
      JSON.stringify({
        ...target,
        semanticsMs: 3,
        semantics: {
          source: "windows_ui_automation",
          status: "unavailable",
          viewport: { x: 10, y: 20, width: 1280, height: 720 },
          controls: [],
          truncated: false,
        },
      }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    expect((await driver.observeSemantics(target)).semantics).toEqual({
      source: "windows_ui_automation",
      status: "unavailable",
      viewport: { x: 10, y: 20, width: 1280, height: 720 },
      controls: [],
      truncated: false,
    })
  })

  it("refuses changed targets and malformed semantic-only output", async () => {
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:10,20,1280,720" }
    const semantic = {
      source: "windows_ui_automation",
      status: "unavailable",
      viewport: { x: 10, y: 20, width: 1280, height: 720 },
      controls: [],
      truncated: false,
    }
    const test = harness([
      JSON.stringify({ ...target, windowID: "0x456", semanticsMs: 1, semantics: semantic }),
      JSON.stringify({ ...target, semanticsMs: 1, semantics: { ...semantic, controls: [{}] } }),
      JSON.stringify({ ...target, semanticsMs: 1, semantics: semantic, data: "pixels" }),
      JSON.stringify({ ...target, semanticsMs: -1, semantics: semantic }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    await expect(driver.observeSemantics(target)).rejects.toThrow(/foreground window changed/i)
    await expect(driver.observeSemantics(target)).rejects.toThrow(/UI Automation control identity is incomplete/i)
    await expect(driver.observeSemantics(target)).rejects.toThrow(/unexpectedly contains pixels/i)
    await expect(driver.observeSemantics(target)).rejects.toThrow(/semantic timing is invalid/i)
  })

  it("checks native process identity within the same bounded semantic observation", async () => {
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:10,20,1280,720" }
    const identity = "A".repeat(64)
    const semantics = {
      source: "windows_ui_automation",
      status: "unavailable",
      viewport: { x: 10, y: 20, width: 1280, height: 720 },
      controls: [],
      truncated: false,
    }
    const test = harness([
      JSON.stringify({ ...target, identity: "B".repeat(64), semanticsMs: 1, semantics }),
      JSON.stringify({ ...target, semanticsMs: 1, semantics }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    await expect(driver.observeSemantics({ ...target, identity })).rejects.toThrow(/process identity changed/i)
    await expect(driver.observeSemantics({ ...target, identity })).rejects.toThrow(/process identity is invalid/i)
    expect(test.scripts).toHaveLength(2)
    expect(test.scripts[0]).toContain("Desktop process identity changed before semantic observation")
    expect(test.scripts[0]).toContain("Desktop process identity changed while correlating semantic observations")
    expect(test.scripts[0]).not.toContain("CopyFromScreen")
  })

  it("refuses semantic bounds that differ from or fall outside the target", async () => {
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:10,20,1280,720" }
    const base = {
      ...target,
      semanticsMs: 1,
      semantics: {
        source: "windows_ui_automation",
        status: "available",
        viewport: { x: 11, y: 20, width: 1280, height: 720 },
        controls: [],
        truncated: false,
      },
    }
    const test = harness([
      JSON.stringify(base),
      JSON.stringify({
        ...base,
        semantics: {
          ...base.semantics,
          viewport: { x: 10, y: 20, width: 1280, height: 720 },
          controls: [
            {
              controlID: "outside",
              role: "Button",
              x: 2000,
              y: 80,
              width: 20,
              height: 20,
              enabled: true,
              focused: false,
              actions: [],
            },
          ],
        },
      }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    await expect(driver.observeSemantics(target)).rejects.toThrow(/viewport changed/i)
    await expect(driver.observeSemantics(target)).rejects.toThrow(/outside the exact target/i)
  })

  it("serves a recent continuous visual frame only for the exact foreground target", async () => {
    const visual = {
      windowID: "0x123",
      location: "pid:5;title:Editor;bounds:0,0,20,10",
      width: 20,
      height: 10,
      mime: "image/png",
      data: "background pixels",
      acquisitionMs: 0,
      preparationMs: 0,
    }
    const primary = harness([
      JSON.stringify({ windowID: visual.windowID, location: visual.location }),
      JSON.stringify({ ...visual, data: "fresh pixels" }),
      JSON.stringify({ windowID: visual.windowID, location: "pid:5;title:Editor;bounds:1,0,20,10" }),
      JSON.stringify({ ...visual, location: "pid:5;title:Editor;bounds:1,0,20,10", data: "fresh pixels" }),
    ])
    let captures = 0
    let cancelled = 0
    const background = {
      run: async () => {
        captures++
        if (captures === 1) return JSON.stringify(visual)
        return new Promise<string>(() => undefined)
      },
      cancel: () => {
        cancelled++
      },
    }
    const driver = new WindowsDesktopDriver(primary.runner, background)
    const errors: unknown[] = []
    driver.startCapture((error) => errors.push(error))
    for (let index = 0; index < 50 && captures < 2; index++) await Bun.sleep(2)
    expect(captures).toBe(2)
    expect((await driver.observe({ semantics: false })).data).toBe("background pixels")
    expect((await driver.observe({ semantics: false, fresh: true })).data).toBe("fresh pixels")
    expect(primary.scripts.filter((script) => script.includes("CopyFromScreen"))).toHaveLength(1)
    expect((await driver.observe({ semantics: false })).data).toBe("fresh pixels")
    expect(primary.scripts.filter((script) => script.includes("CopyFromScreen"))).toHaveLength(2)
    driver.cancel()
    expect(cancelled).toBe(1)
    expect(errors).toHaveLength(0)
  })

  it("keeps a pixel-identical scene usable when capture advances during target verification", async () => {
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,20,10" }
    const visual = {
      ...target,
      width: 20,
      height: 10,
      mime: "image/png",
      data: "same pixels",
      acquisitionMs: 0,
      preparationMs: 0,
    }
    let captures = 0
    const background = {
      run: async () => {
        captures++
        if (captures <= 2) return JSON.stringify(visual)
        return new Promise<string>(() => undefined)
      },
      cancel: () => undefined,
    }
    const primary = {
      run: async (script: string) => {
        expect(script).not.toContain("CopyFromScreen")
        await Bun.sleep(115)
        return JSON.stringify(target)
      },
      cancel: () => undefined,
    }
    const driver = new WindowsDesktopDriver(primary, background)
    driver.startCapture((error) => {
      throw error
    })
    for (let index = 0; index < 100 && captures < 1; index++) await Bun.sleep(2)
    await Bun.sleep(2)
    expect((await driver.observe({ semantics: false })).data).toBe("same pixels")
    expect(captures).toBeGreaterThanOrEqual(2)
    driver.stopCapture()
  })

  it("joins a warm visual frame with UI Automation for a normal desktop observation", async () => {
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,20,10" }
    const visual = {
      ...target,
      width: 20,
      height: 10,
      mime: "image/png",
      data: "warm pixels",
      acquisitionMs: 0,
      preparationMs: 0,
    }
    const semantic = {
      source: "windows_ui_automation",
      status: "available",
      viewport: { x: 0, y: 0, width: 20, height: 10 },
      controls: [],
      truncated: false,
    }
    const primary = harness([
      JSON.stringify({ ...target, semanticsMs: 4, semantics: semantic }),
      JSON.stringify(target),
    ])
    let captures = 0
    const background = {
      run: async () => {
        captures++
        if (captures === 1) return JSON.stringify(visual)
        return new Promise<string>(() => undefined)
      },
      cancel: () => undefined,
    }
    const driver = new WindowsDesktopDriver(primary.runner, background)
    driver.startCapture(() => undefined)
    for (let index = 0; index < 50 && captures < 1; index++) await Bun.sleep(2)
    await Bun.sleep(2)

    const result = await driver.observe()
    expect(result.data).toBe("warm pixels")
    expect(result.semantics).toEqual(semantic)
    expect(result.timing).toMatchObject({ acquisitionMs: 0, preparationMs: 0, semanticsMs: 4 })
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(4)
    expect(primary.scripts).toHaveLength(2)
    expect(primary.scripts.some((script) => script.includes("CopyFromScreen"))).toBe(false)
    driver.cancel()
  })

  it("refuses to join warm pixels when the foreground target changes during UI Automation", async () => {
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,20,10" }
    const primary = harness([
      JSON.stringify({
        ...target,
        semanticsMs: 1,
        semantics: {
          source: "windows_ui_automation",
          status: "unavailable",
          viewport: { x: 0, y: 0, width: 20, height: 10 },
          controls: [],
          truncated: false,
        },
      }),
      JSON.stringify({ ...target, windowID: "0x456" }),
    ])
    let captures = 0
    const driver = new WindowsDesktopDriver(primary.runner, {
      run: async () => {
        captures++
        if (captures === 1)
          return JSON.stringify({
            ...target,
            width: 20,
            height: 10,
            mime: "image/png",
            data: "warm pixels",
            acquisitionMs: 0,
            preparationMs: 0,
          })
        return new Promise<string>(() => undefined)
      },
      cancel: () => undefined,
    })
    driver.startCapture(() => undefined)
    for (let index = 0; index < 50 && captures < 1; index++) await Bun.sleep(2)
    await Bun.sleep(2)

    await expect(driver.observe()).rejects.toThrow(/foreground window changed/i)
    expect(primary.scripts.some((script) => script.includes("CopyFromScreen"))).toBe(false)
    driver.cancel()
  })

  it("refuses accessibility data when the worker observed changed pixels during collection", async () => {
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,20,10" }
    const visual = {
      ...target,
      width: 20,
      height: 10,
      mime: "image/png",
      acquisitionMs: 0,
      preparationMs: 0,
    }
    let captures = 0
    const primary = {
      run: async (script: string) => {
        if (script.includes("Get-RayaControls $window")) {
          for (let index = 0; index < 100 && captures < 2; index++) await Bun.sleep(2)
          await Bun.sleep(2)
          return JSON.stringify({
            ...target,
            semanticsMs: 1,
            semantics: {
              source: "windows_ui_automation",
              status: "unavailable",
              viewport: { x: 0, y: 0, width: 20, height: 10 },
              controls: [],
              truncated: false,
            },
          })
        }
        return JSON.stringify(target)
      },
      cancel: () => undefined,
    }
    const driver = new WindowsDesktopDriver(primary, {
      run: async () => {
        captures++
        if (captures === 1) return JSON.stringify({ ...visual, data: "first" })
        if (captures === 2) return JSON.stringify({ ...visual, data: "second" })
        return new Promise<string>(() => undefined)
      },
      cancel: () => undefined,
    })
    driver.startCapture(() => undefined)
    for (let index = 0; index < 50 && captures < 1; index++) await Bun.sleep(2)
    await Bun.sleep(2)

    await expect(driver.observe()).rejects.toThrow(/pixels changed while correlating/i)
    driver.cancel()
  })

  it("parses foreground-window observations and identity", async () => {
    const test = harness([
      JSON.stringify({
        windowID: "0x123",
        location: "pid:5;title:Editor;bounds:0,0,1280,720",
        width: 1280,
        height: 720,
        mime: "image/png",
        data: "png",
        acquisitionMs: 0,
        preparationMs: 0,
        semanticsMs: 0,
        semantics: {
          source: "windows_ui_automation",
          status: "available",
          viewport: { x: 0, y: 0, width: 1280, height: 720 },
          truncated: false,
          controls: [
            {
              controlID: "42.7",
              role: "Button",
              name: "Save",
              automationID: "save",
              x: 100,
              y: 80,
              width: 64,
              height: 28,
              enabled: true,
              focused: false,
              selected: null,
              actions: ["invoke"],
            },
          ],
        },
      }),
      JSON.stringify({ windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    const frame = await driver.observe()
    expect(frame).toMatchObject({
      windowID: "0x123",
      width: 1280,
      height: 720,
      data: "png",
      timing: { acquisitionMs: 0, preparationMs: 0, semanticsMs: 0 },
      semantics: {
        source: "windows_ui_automation",
        status: "available",
        viewport: { x: 0, y: 0, width: 1280, height: 720 },
        truncated: false,
        controls: [expect.objectContaining({ controlID: "42.7", role: "Button", name: "Save", actions: ["invoke"] })],
      },
    })
    expect(frame.timing.totalMs).toBeGreaterThanOrEqual(0)
    expect(await driver.current()).toEqual({
      windowID: "0x123",
      location: "pid:5;title:Editor;bounds:0,0,1280,720",
    })
    expect(test.scripts[0]).toContain("CopyFromScreen")
    expect(test.scripts[0]).toContain("$visible.Left = [Math]::Max($rect.Left, $desktopLeft)")
    expect(test.scripts[0]).toContain("$visible.Right = [Math]::Min($rect.Right, $desktopLeft + $desktopWidth)")
    expect(test.scripts[0]).toContain("Rect = $visible")
    expect(test.scripts[0]).toContain("$area = [double]$window.Width * [double]$window.Height")
    expect(test.scripts[0]).toContain("StretchBlt(destination, 0, 0, targetWidth, targetHeight")
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::Capture($context, $width, $height")
    expect(test.scripts[0]).not.toContain("$tileSize")
    expect(test.scripts[0]).toContain("New-Object RayaBoundedStream 15000000")
    expect(test.scripts[0]).toContain('$mime = "image/jpeg"')
    expect(test.scripts[0]).toContain("function Test-RayaImage($stream)")
    expect(test.scripts[0]).toContain("[Drawing.Image]::FromStream($stream, $false, $true)")
    expect(test.scripts[0]).toContain(
      'throw new InvalidOperationException("Desktop capture exceeds the encoded image limit")',
    )
    expect(test.scripts[0]).toContain("$stream.GetBuffer(), 0, [int]$stream.Length")
    expect(test.scripts[0]).toContain("$image.LockBits")
    expect(test.scripts[0]).toContain("$size -gt 33177600")
    expect(test.scripts[0]).toContain("[Security.Cryptography.SHA256]::Create()")
    expect(test.scripts[0]).toContain("$global:RayaCaptureCache")
    expect(test.scripts[0]).toContain("change = if ($unchanged) { 'unchanged' } else { 'keyframe' }")
    expect(test.scripts[0]).toContain("if (-not $unchanged) {")
    expect(test.scripts[0]).toContain("$acquisition = [Diagnostics.Stopwatch]::StartNew()")
    expect(test.scripts[0]).toContain("$preparation = [Diagnostics.Stopwatch]::StartNew()")
    expect(test.scripts[0]).toContain("$semanticsTimer = [Diagnostics.Stopwatch]::StartNew()")
    expect(test.scripts[0]).toContain("acquisitionMs = $acquisition.Elapsed.TotalMilliseconds")
    expect(test.scripts[0]).toContain("$semanticOutput = @(Get-RayaControls $window)")
    expect(test.scripts[0]).toContain("$semantics = $semanticOutput[-1]")
    expect(test.scripts[0]).toContain("ConvertTo-Json -Depth 8 -Compress")
    expect(test.scripts[0]).toContain("[Windows.Automation.AutomationElement]::FromHandle($window.Handle)")
    expect(test.scripts[0]).toContain("[Windows.Automation.CacheRequest]::new()")
    expect(test.scripts[0]).toContain("[Windows.Automation.TreeScope]::Children")
    expect(test.scripts[0]).toContain("$item = $item.GetUpdatedCache($cache)")
    expect(test.scripts[0]).toContain("$children = $item.CachedChildren")
    expect(test.scripts[0]).toContain("$remaining = 1024 - $visited - $queue.Count")
    expect(test.scripts[0]).toContain("$count = [Math]::Min($children.Count, [Math]::Max(0, $remaining))")
    expect(test.scripts[0]).toContain("if ($children.Count -gt $count) { $truncated = $true }")
    expect(test.scripts[0]).toContain("truncated = $truncated -or $queue.Count -gt 0")
    expect(test.scripts[0]).not.toContain("[Windows.Automation.TreeWalker]")
    expect(test.scripts[0]).toContain("$current = $item.Cached")
    expect(test.scripts[0]).toContain("TryGetCachedPattern")
    expect(test.scripts[0]).not.toContain("GetSupportedPatterns()")
    expect(test.scripts[0]).toContain("$visited -lt 1024 -and $controls.Count -lt 256")
    expect(test.scripts[0]).toContain("controls = @($controls)")
    expect(test.scripts[0]).toContain("actions = @($actions)")
    expect(test.scripts[0]).toContain("Foreground window changed while correlating visual and semantic observations")
    expect(test.scripts[0]).not.toContain("$stream.ToArray()")
    expect(test.scripts[0]).toContain("width = $width")
    expect(test.scripts[0]).toContain("height = $height")
    expect(test.scripts[0]).toContain("SetThreadDpiAwarenessContext(new IntPtr(-4))")
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::EnableDpiAwareness()")
    expect(test.scripts[0]).toContain("desktop coordinates are unsafe")
    expect(test.scripts[1]).not.toContain("CopyFromScreen")
    expect(test.scripts[1]).toContain("[RayaDesktopNative]::EnableDpiAwareness()")
  })

  it("reuses one bounded local keyframe when native pixels are exactly unchanged", async () => {
    const base = {
      windowID: "0x123",
      location: "pid:5;title:Editor;bounds:0,0,20,10",
      width: 20,
      height: 10,
      acquisitionMs: 0,
      preparationMs: 0,
      semanticsMs: 0,
    }
    const semantics = (focused: boolean) => ({
      source: "windows_ui_automation",
      status: "available",
      viewport: { x: 0, y: 0, width: 20, height: 10 },
      controls: [
        {
          controlID: "editor",
          role: "Edit",
          x: 0,
          y: 0,
          width: 20,
          height: 10,
          enabled: true,
          focused,
          actions: ["value"],
        },
      ],
      truncated: false,
    })
    const test = harness([
      JSON.stringify({ ...base, change: "keyframe", mime: "image/png", data: "encoded", semantics: semantics(false) }),
      JSON.stringify({ ...base, change: "unchanged", semantics: semantics(true) }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    const first = await driver.observe()
    const second = await driver.observe()

    expect(first).toMatchObject({ data: "encoded", mime: "image/png", semantics: { controls: [{ focused: false }] } })
    expect(second).toMatchObject({
      data: "encoded",
      mime: "image/png",
      timing: { preparationMs: 0 },
      semantics: { controls: [{ focused: true }] },
    })
  })

  it("can measure visual capture without placing UI Automation on its critical path", async () => {
    const test = harness([
      JSON.stringify({
        windowID: "0x123",
        location: "pid:5;title:Editor;bounds:0,0,20,10",
        width: 20,
        height: 10,
        mime: "image/png",
        data: "encoded",
        acquisitionMs: 0,
        preparationMs: 0,
      }),
    ])
    const frame = await new WindowsDesktopDriver(test.runner).observe({ semantics: false })
    expect(frame.semantics).toBeUndefined()
    expect(frame.timing).toEqual(expect.objectContaining({ acquisitionMs: 0, preparationMs: 0 }))
    expect(frame.timing.semanticsMs).toBeUndefined()
    expect(test.scripts[0]).toContain("$collectSemantics = $false")
    expect(test.scripts[0]).toContain("if ($collectSemantics) {")
  })

  it("refuses an unchanged native frame without an exact local keyframe", async () => {
    const output = JSON.stringify({
      windowID: "0x123",
      location: "pid:5;title:Editor;bounds:0,0,20,10",
      width: 20,
      height: 10,
      change: "unchanged",
      acquisitionMs: 0,
      preparationMs: 0,
      semanticsMs: 0,
      semantics: {
        source: "windows_ui_automation",
        status: "unavailable",
        viewport: { x: 0, y: 0, width: 20, height: 10 },
        controls: [],
        truncated: false,
      },
    })
    const driver = new WindowsDesktopDriver(harness([output]).runner)
    await expect(driver.observe()).rejects.toThrow(/no matching local keyframe/i)
  })

  it("refuses malformed unchanged-frame claims", async () => {
    const base = {
      windowID: "0x123",
      location: "pid:5;title:Editor;bounds:0,0,20,10",
      width: 20,
      height: 10,
      acquisitionMs: 0,
      preparationMs: 0,
      semanticsMs: 0,
    }
    const semantic = {
      source: "windows_ui_automation",
      status: "unavailable",
      viewport: { x: 0, y: 0, width: 20, height: 10 },
      controls: [],
      truncated: false,
    }
    const pixels = new WindowsDesktopDriver(
      harness([
        JSON.stringify({ ...base, change: "keyframe", mime: "image/png", data: "encoded", semantics: semantic }),
        JSON.stringify({ ...base, change: "unchanged", mime: "image/png", data: "replayed", semantics: semantic }),
      ]).runner,
    )
    await pixels.observe()
    await expect(pixels.observe()).rejects.toThrow(/unexpectedly contains encoded pixels/i)

    const state = new WindowsDesktopDriver(
      harness([JSON.stringify({ ...base, change: "delta", semantics: semantic })]).runner,
    )
    await expect(state.observe()).rejects.toThrow(/change state is invalid/i)
  })

  it("invalidates the local keyframe when capture is cancelled", async () => {
    const base = {
      windowID: "0x123",
      location: "pid:5;title:Editor;bounds:0,0,20,10",
      width: 20,
      height: 10,
      acquisitionMs: 0,
      preparationMs: 0,
      semanticsMs: 0,
      semantics: {
        source: "windows_ui_automation",
        status: "unavailable",
        viewport: { x: 0, y: 0, width: 20, height: 10 },
        controls: [],
        truncated: false,
      },
    }
    const test = harness([
      JSON.stringify({ ...base, change: "keyframe", mime: "image/png", data: "encoded" }),
      JSON.stringify({ ...base, change: "unchanged" }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    await driver.observe()
    driver.cancel()

    expect(test.cancelled()).toBe(1)
    await expect(driver.observe()).rejects.toThrow(/no matching local keyframe/i)
  })

  it("lists visible windows and focuses an exact encoded identity", async () => {
    const test = harness([
      JSON.stringify({
        windows: [
          {
            windowID: "0x123",
            location: "pid:5;class:Editor;title:Editor",
            title: "Editor",
            processID: 5,
            x: 10,
            y: 20,
            width: 1280,
            height: 720,
            minimized: false,
            foreground: true,
          },
        ],
      }),
      "",
    ])
    const driver = new WindowsDesktopDriver(test.runner)
    const windows = await driver.windows()
    await driver.focus(windows[0])

    expect(windows).toEqual([
      expect.objectContaining({ windowID: "0x123", title: "Editor", processID: 5, foreground: true }),
    ])
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::Windows()")
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::EnableDpiAwareness()")
    expect(test.scripts[1]).not.toContain(windows[0].location)
    expect(test.scripts[1]).toContain(Buffer.from(JSON.stringify(windows[0]), "utf8").toString("base64"))
    expect(test.scripts[1]).toContain("[RayaDesktopNative]::Focus")
    expect(test.scripts[1]).toContain("[RayaDesktopNative]::EnableDpiAwareness()")
    expect(test.scripts[1]).toContain("AttachThreadInput")
    expect(test.scripts[1]).toContain("attempt < 10")
    expect(test.scripts[1]).toContain("ValidateIdleInput()")
  })

  it("passes actions as encoded JSON instead of interpolated text", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    const text = 'hello `$(Get-ChildItem) "world"'
    const action = {
      operation: "type" as const,
      windowID: "0x123",
      observationID: "obs-1",
      sensitive: false as const,
      text,
    }
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" }
    await driver.perform(action, target)

    expect(test.scripts[0]).not.toContain(text)
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::EnableDpiAwareness()")
    expect(test.scripts[0]).toContain(Buffer.from(JSON.stringify({ action, target }), "utf8").toString("base64"))
    expect(test.scripts[0]).toContain(
      "$window.WindowID -ne $payload.target.windowID -or $window.Location -ne $payload.target.location",
    )
    driver.cancel()
    expect(test.cancelled()).toBe(1)
  })

  it("batches drag positioning, down, movement, and release with recovery", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    const action = {
      operation: "drag" as const,
      windowID: "0x123",
      observationID: "obs-drag",
      sensitive: false,
      startX: 0.2,
      startY: 0.3,
      endX: 0.8,
      endY: 0.7,
      button: "left" as const,
    }
    await driver.perform(action, { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" })

    expect(test.scripts[0]).toContain("SendInput(4, inputs")
    expect(test.scripts[0]).toContain("Mouse(up, 0)")
    expect(test.scripts[0]).toContain("GetSystemMetrics(76)")
    expect(test.scripts[0]).toContain("ValidatePoint(expectedStartX, expectedStartY)")
    expect(test.scripts[0]).toContain("ValidatePoint(expectedEndX, expectedEndY)")
    expect(test.scripts[0]).toContain("ValidateTarget(expectedStartX, expectedStartY)")
    expect(test.scripts[0]).toContain("ValidateTarget(expectedEndX, expectedEndY)")
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::Move($startX, $startY)")
    expect(test.scripts[0]).toContain(
      "[RayaDesktopNative]::Drag($absoluteStartX, $absoluteStartY, $absoluteEndX, $absoluteEndY, $startX, $startY, $endX, $endY, $down, $up)",
    )
    expect(test.scripts[0]).toContain("Windows did not finish the drag at the exact desktop point")
  })

  it("batches click positioning, press, and release with recovery", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    await driver.perform(
      {
        operation: "pointer",
        action: "double_click",
        windowID: "0x123",
        observationID: "obs-click",
        sensitive: false,
        x: 0.25,
        y: 0.75,
        button: "right",
      },
      { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" },
    )

    expect(test.scripts[0]).toContain("SendInput((uint)batch.Length, batch")
    expect(test.scripts[0]).toContain("Mouse(up, 0)")
    expect(test.scripts[0]).toContain(
      '[RayaDesktopNative]::Click($absoluteX, $absoluteY, $x, $y, $down, $up, $action.action -eq "double_click")',
    )
    expect(test.scripts[0]).toContain("Windows did not click the exact desktop point")
    expect(test.scripts[0]).toContain("ValidateTarget(expectedX, expectedY)")
    expect(test.scripts[0]).toContain("Another application covers the grounded desktop point")
    expect(test.scripts[0]).toContain("GetAsyncKeyState(key) & 0x8000")
    expect(test.scripts[0]).toContain("Manual keyboard or pointer input is held")
    expect(test.scripts[0]).toContain('if ($action.action -eq "move") {')
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::Mouse($down, 0)")
  })

  it("refuses off-screen pointer movement and verifies exact native placement", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    await driver.perform(
      {
        operation: "pointer",
        action: "move",
        windowID: "0x123",
        observationID: "obs-point",
        sensitive: false,
        x: 0.5,
        y: 0.5,
        button: "left",
      },
      { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" },
    )

    expect(test.scripts[0]).toContain("ValidatePoint(x, y)")
    expect(test.scripts[0]).toContain("ValidateTarget(x, y)")
    expect(test.scripts[0]).toContain("WindowFromPoint(new Point { X = x, Y = y })")
    expect(test.scripts[0]).toContain("GetCursorPos(out point)")
    expect(test.scripts[0]).toContain("Desktop point is outside the physical virtual desktop")
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::Move($x, $y)")
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::SetCursorPos($x, $y)")
  })

  it("batches key chords and limits partial recovery to accepted downs", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    await driver.perform(
      {
        operation: "key",
        windowID: "0x123",
        observationID: "obs-key",
        sensitive: false,
        key: "Enter",
        modifiers: ["control", "shift"],
      },
      { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" },
    )

    expect(test.scripts[0]).toContain("new Input[(modifiers.Length * 2) + 2]")
    expect(test.scripts[0]).toContain("foreach (var held in HeldKeys(inputs, accepted)) Release(held)")
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::Chord([uint16]$key, [uint16[]]$held)")
    expect(test.scripts[0]).toContain(
      "public static void Chord(ushort key, ushort[] modifiers) {\n    ValidateIdleInput();",
    )
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::Key($key, $false)")
  })

  it("batches complete Unicode text and recovers an unmatched key-down after partial dispatch", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    await driver.perform(
      { operation: "type", windowID: "0x123", observationID: "obs-type", sensitive: false, text: "A" },
      { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" },
    )

    expect(test.scripts[0]).toContain("new Input[checked(text.Length * 2)]")
    expect(test.scripts[0]).toContain("public static void Text(string text) {\n    ValidateIdleInput();")
    expect(test.scripts[0]).toContain("SendInput((uint)inputs.Length, inputs")
    expect(test.scripts[0]).toContain("accepted % 2 == 1")
    expect(test.scripts[0]).toContain("inputs[accepted]")
    expect(test.scripts[0]).not.toContain("foreach (var character in text)")
    expect(test.scripts[0]).toContain("Windows refused complete desktop text input")
  })

  it("batches both scroll axes into one native dispatch", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    await driver.perform(
      {
        operation: "scroll",
        windowID: "0x123",
        observationID: "obs-scroll",
        sensitive: false,
        deltaX: -120,
        deltaY: 240,
      },
      { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" },
    )

    expect(test.scripts[0]).toContain("unchecked((uint)deltaY)")
    expect(test.scripts[0]).toContain("unchecked((uint)deltaX)")
    expect(test.scripts[0]).toContain("SendInput((uint)batch.Length, batch")
    expect(test.scripts[0]).toContain("Windows refused complete desktop scroll input")
    expect(test.scripts[0]).toContain("public static void Scroll(int deltaX, int deltaY) {\n    ValidateIdleInput();")
    expect(test.scripts[0]).toContain(
      "[RayaDesktopNative]::Scroll([int][Math]::Round($action.deltaX), [int][Math]::Round($action.deltaY))",
    )
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::Mouse(0x0800, $data)")
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::Mouse(0x1000, $data)")
  })

  it("rejects malformed native output", async () => {
    const test = harness([JSON.stringify({ windowID: "0x123" })])
    const driver = new WindowsDesktopDriver(test.runner)
    await expect(driver.observe()).rejects.toThrow(/identity is incomplete/i)
  })

  it("rejects malformed or over-capacity UI Automation output", async () => {
    const base = {
      windowID: "0x123",
      location: "pid:5;title:Editor;bounds:0,0,1280,720",
      width: 1280,
      height: 720,
      mime: "image/png",
      data: "png",
      acquisitionMs: 0,
      preparationMs: 0,
      semanticsMs: 0,
    }
    const test = harness([
      JSON.stringify({
        ...base,
        semantics: {
          source: "windows_ui_automation",
          status: "available",
          viewport: { x: 0, y: 0, width: 1280, height: 720 },
          truncated: false,
          controls: [{ controlID: "x", role: "Button", width: -1 }],
        },
      }),
      JSON.stringify({
        ...base,
        semantics: {
          source: "windows_ui_automation",
          status: "available",
          viewport: { x: 0, y: 0, width: 1280, height: 720 },
          truncated: true,
          controls: Array.from({ length: 257 }, (_, index) => ({
            controlID: String(index),
            role: "Button",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            enabled: true,
            focused: false,
            actions: [],
          })),
        },
      }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    await expect(driver.observe()).rejects.toThrow(/UI Automation control bounds are invalid/i)
    await expect(driver.observe()).rejects.toThrow(/UI Automation observation is incomplete/i)
  })

  it("accepts explicit unavailable UI Automation without inventing controls", async () => {
    const test = harness([
      JSON.stringify({
        windowID: "0x123",
        location: "pid:5;title:Editor;bounds:0,0,1280,720",
        width: 1280,
        height: 720,
        mime: "image/png",
        data: "png",
        acquisitionMs: 0,
        preparationMs: 0,
        semanticsMs: 0,
        semantics: {
          source: "windows_ui_automation",
          status: "unavailable",
          viewport: { x: 0, y: 0, width: 1280, height: 720 },
          truncated: false,
          controls: [],
        },
      }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    expect((await driver.observe()).semantics).toEqual({
      source: "windows_ui_automation",
      status: "unavailable",
      viewport: { x: 0, y: 0, width: 1280, height: 720 },
      truncated: false,
      controls: [],
    })
  })

  it("rejects native observations outside the bounded capture envelope", async () => {
    const test = harness([
      JSON.stringify({
        windowID: "0x123",
        location: "pid:5;title:Editor;bounds:0,0,8192,2160",
        width: 4097,
        height: 2023,
        mime: "image/png",
        data: "png",
        acquisitionMs: 0,
        preparationMs: 0,
      }),
      JSON.stringify({
        windowID: "0x123",
        location: "pid:5;title:Editor;bounds:0,0,4096,4096",
        width: 4096,
        height: 4096,
        mime: "image/png",
        data: "png",
        acquisitionMs: 0,
        preparationMs: 0,
      }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    await expect(driver.observe()).rejects.toThrow(/dimensions exceed the safe capture bounds/i)
    await expect(driver.observe()).rejects.toThrow(/pixel count exceeds the safe capture bounds/i)
  })

  it("accepts the bounded JPEG fallback", async () => {
    const test = harness([
      JSON.stringify({
        windowID: "0x123",
        location: "pid:5;title:Editor;bounds:0,0,3840,2160",
        width: 3840,
        height: 2160,
        mime: "image/jpeg",
        data: "jpeg",
        acquisitionMs: 0,
        preparationMs: 0,
      }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    expect(await driver.observe()).toMatchObject({ width: 3840, height: 2160, mime: "image/jpeg", data: "jpeg" })
  })
})
