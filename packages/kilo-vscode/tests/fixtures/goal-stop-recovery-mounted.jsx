import "@kilocode/kilo-ui/styles"
import { render } from "solid-js/web"
import { StoryProviders } from "../../webview-ui/src/stories/StoryProviders"
import { SessionProvider, useSession } from "../../webview-ui/src/context/session"
import { GoalBanner } from "../../webview-ui/src/components/chat/GoalBanner"

window.__posts = []
window.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage: (message) => window.__posts.push(message),
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
  window.__session = useSession()
  return <GoalBanner />
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
