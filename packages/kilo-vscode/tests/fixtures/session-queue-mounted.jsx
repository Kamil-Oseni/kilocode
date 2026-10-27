import "@kilocode/kilo-ui/styles"
import { render } from "solid-js/web"
import { StoryProviders } from "../../webview-ui/src/stories/StoryProviders"
import { SessionProvider, useSession } from "../../webview-ui/src/context/session"
import { MessageList } from "../../webview-ui/src/components/chat/MessageList"
import { SessionDock } from "../../webview-ui/src/components/chat/SessionDock"
window.__sent = []
window.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage: (message) => window.__sent.push(message),
})
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
  const session = useSession()
  window.__session = session
  if (new URLSearchParams(location.search).has("inference"))
    return (
      <>
        <SessionDock blocked={session.permissions().length > 0 || session.questions().length > 0} />
        <button onClick={() => session.abort()}>Stop fixture turn</button>
      </>
    )
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
