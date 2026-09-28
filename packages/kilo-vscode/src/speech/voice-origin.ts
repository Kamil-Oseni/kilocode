/** A replaced webview cannot retain ownership by presenting the same chat identity. */
export class VoiceOrigin {
  private epoch = 0
  private owner?: object

  bind(owner: object): () => boolean {
    const epoch = ++this.epoch
    this.owner = owner
    return () => this.owner === owner && this.epoch === epoch
  }

  clear(): void {
    this.epoch++
    this.owner = undefined
  }
}
