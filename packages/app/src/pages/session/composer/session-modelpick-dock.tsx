import { createMemo, Show } from "solid-js"
import type { ModelPickRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { List } from "@opencode-ai/ui/list"
import { Tag } from "@opencode-ai/ui/tag"
import { DockPrompt } from "@opencode-ai/session-ui/dock-prompt"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

export function SessionModelPickDock(props: {
  request: ModelPickRequest
  responding: boolean
  onPick: (model: { providerID: string; modelID: string }) => void
  onDismiss: () => void
}) {
  const language = useLanguage()
  const local = useLocal()

  const models = createMemo(() =>
    local.model
      .list()
      .filter((m) => local.model.visible({ modelID: m.id, providerID: m.provider.id })),
  )

  return (
    <DockPrompt
      kind="modelpick"
      header={<div data-slot="modelpick-header-title">{language.t("session.modelpick.title")}</div>}
      footer={
        <>
          <div />
          <div data-slot="modelpick-footer-actions">
            <Button variant="ghost" size="normal" disabled={props.responding} onClick={props.onDismiss}>
              {language.t("ui.common.dismiss")}
            </Button>
          </div>
        </>
      }
    >
      <div data-slot="modelpick-text">
        {props.request.subproblem
          ? language.t("session.modelpick.subproblem", {
              role: props.request.role,
              subproblem: props.request.subproblem,
            })
          : language.t("session.modelpick.role", { role: props.request.role })}
      </div>
      <div data-slot="modelpick-list">
        <List
          class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
          search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true }}
          emptyMessage={language.t("dialog.model.empty")}
          key={(x) => `${x.provider.id}:${x.id}`}
          items={models()}
          filterKeys={["provider.name", "name", "id"]}
          sortBy={(a, b) => a.name.localeCompare(b.name)}
          groupBy={(x) => x.provider.name}
          onSelect={(x) => {
            if (!x) return
            props.onPick({ providerID: x.provider.id, modelID: x.id })
          }}
        >
          {(i) => (
            <div class="w-full flex items-center gap-x-2 text-13-regular">
              <span class="truncate">{i.name}</span>
              <Show when={isFree(i.provider.id, i.cost)}>
                <Tag>{language.t("model.tag.free")}</Tag>
              </Show>
              <Show when={i.latest}>
                <Tag>{language.t("model.tag.latest")}</Tag>
              </Show>
            </div>
          )}
        </List>
      </div>
    </DockPrompt>
  )
}
