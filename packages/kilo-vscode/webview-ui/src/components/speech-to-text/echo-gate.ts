// raya_change - Persistent residual-echo floor for full-duplex cascade barge-in.
export class EchoGate {
  private echo = 0
  private warm = 0
  private scale = 1.25

  reset() {
    this.echo = 0
    this.warm = 0
    this.scale = 1.25
  }

  reject() {
    this.scale = Math.min(2.5, this.scale + 0.25)
  }

  hears(rms: number, threshold: number, active: boolean) {
    if (!active) return rms >= threshold
    if (this.warm < 20) {
      this.echo = Math.max(this.echo, rms)
      this.warm++
      return false
    }
    const gate = Math.max(threshold, this.echo * this.scale + 0.004)
    if (rms >= gate) return true
    this.echo = this.echo === 0 ? rms : this.echo * 0.9 + rms * 0.1
    return false
  }
}
