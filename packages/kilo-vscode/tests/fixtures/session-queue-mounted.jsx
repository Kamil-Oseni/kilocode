import "@kilocode/kilo-ui/styles"
import { render } from "solid-js/web"
import { StoryProviders } from "../../webview-ui/src/stories/StoryProviders"
import { SessionProvider, useSession } from "../../webview-ui/src/context/session"
import { MessageList } from "../../webview-ui/src/components/chat/MessageList"
window.acquireVsCodeApi = () => ({ getState: () => undefined, setState: () => {}, postMessage: () => {} })
window.__deliver = (message) =>
  new Promise((resolve) => {
    const marker = crypto.randomUUID()
    const listener = (event) => {
      if (event.data.__barrier !== marker) return
      window.removeEventListener("message", listener)
      queueMicrotask(resolve)
    }
    window.addEventListener("message", listener)
    window.postMessage({ ...message, __barrier: marker }, "*")
  })
function Probe() {
  window.__session = useSession()
  return <MessageList />
}
render(
  () => (
    <StoryProviders noPadding>
      <SessionProvider>
        <Probe />
      </SessionProvider>
    </StoryProviders>
  ),
  document.getElementById("root"),
)
