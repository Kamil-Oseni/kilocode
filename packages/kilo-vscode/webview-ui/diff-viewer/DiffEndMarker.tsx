import type { Component } from "solid-js"
import { useLanguage } from "../src/context/language"

export const DiffEndMarker: Component = () => {
  const { t } = useLanguage()

  return (
    <div class="am-diff-end-marker">
      <span class="am-diff-end-rule" aria-hidden="true" />
      <p class="am-diff-end-text">{t("agentManager.review.endOfLongDiff")}</p>
    </div>
  )
}
// raya_change - replace the inherited Kilo mascot with a quiet editorial end mark
