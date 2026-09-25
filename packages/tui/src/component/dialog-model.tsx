import { createMemo, createSignal, For } from "solid-js"
import { useLocal } from "../context/local"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useDialog, DIALOG_SIZE_WIDTH } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useSync } from "../context/sync"
import { useRenderer } from "@opentui/solid"
import { selectedForeground, useTheme } from "../context/theme"
import { useBindings } from "../keymap"

const GENERAL = "general"

export type ModelSelection = { providerID: string; modelID: string; id: string }

export function DialogModel(props: {
  providerID?: string
  title?: string
  onSelect?: (selection: ModelSelection) => void
}) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  // Model rows carry long titles plus price and score, so give the picker 15%
  // more room than the default medium dialog.
  dialog.setWidth(Math.round(DIALOG_SIZE_WIDTH.medium * 1.15))
  const renderer = useRenderer()
  const { theme } = useTheme()
  const [query, setQuery] = createSignal("")
  const [tabHover, setTabHover] = createSignal<number>()

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const showExtra = createMemo(() => connected() && !props.providerID)
  // Callers that pass onSelect want the picker as a data-entry step: the chosen
  // model is handed back instead of becoming the session's active model.
  const selecting = () => props.onSelect !== undefined

  const tabs = createMemo(() => [GENERAL, ...(sync.data.bench ?? []).map((item) => item.id)])

  const activeTab = createMemo(() => {
    const saved = local.model.bench()
    return saved !== undefined && tabs().includes(saved) ? saved : GENERAL
  })

  const activeBench = createMemo(
    () => activeTab() === GENERAL ? undefined : (sync.data.bench ?? []).find((item) => item.id === activeTab()),
  )

  function tabLabel(id: string) {
    return id === GENERAL ? "General" : (sync.data.bench ?? []).find((item) => item.id === id)?.name ?? id
  }

  function switchTab(id: string) {
    if (id === activeTab()) return
    local.model.setBench(id)
    // Recenter the selection on the top row once the new tab's options render.
    queueMicrotask(() => {
      const first = options()[0]?.value
      if (typeof first !== "object") return
      selectRef.current?.moveTo(first)
    })
  }

  function cycleTab(direction: 1 | -1) {
    const all = tabs()
    if (all.length < 2) return
    const index = all.indexOf(activeTab())
    switchTab(all[(index + direction + all.length) % all.length])
  }

  useBindings(() => ({
    bindings: [
      { key: "left", desc: "Previous model tab", group: "Model", cmd: () => cycleTab(-1) },
      { key: "h", desc: "Previous model tab", group: "Model", cmd: () => cycleTab(-1) },
      { key: "right", desc: "Next model tab", group: "Model", cmd: () => cycleTab(1) },
      { key: "l", desc: "Next model tab", group: "Model", cmd: () => cycleTab(1) },
    ],
  }))

  const options = createMemo(() => {
    const needle = query().trim()
    const bench = activeBench()
    if (bench !== undefined) return buildBenchOptions(bench, needle)
    return buildGeneralOptions(needle)
  })

  type ModelValue = ReturnType<typeof options>[number]["value"]
  const selectRef: { current?: DialogSelectRef<ModelValue> } = {}

  function buildGeneralOptions(needle: string) {
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((provider) => provider.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: model.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect: () => {
              choose(provider.id, model.id, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            releaseDate: info.release_date,
            description: favorites.some((item) => item.providerID === provider.id && item.modelID === model)
              ? "(Favorite)"
              : undefined,
            category: connected() ? provider.name : undefined,
            disabled: provider.id === "opencode" && model.includes("-nano"),
            footer: info.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect() {
              choose(provider.id, model, info.id)
            },
          })),
          filter((option) => {
            if (!showSections) return true
            if (
              favorites.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            if (
              recents.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            return true
          }),
          (options) => sortModelOptions(options, props.providerID !== undefined),
        ),
      ),
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...sortModelOptions(
          fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj),
          false,
        ),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    return [...favoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  }

  function buildBenchOptions(bench: { id: string; name: string; scores: Record<string, number> }, needle: string) {
    const favorites = connected() ? local.model.favorite() : []
    const list = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            releaseDate: info.release_date,
            providerName: provider.name,
            favorite: favorites.some((item) => item.providerID === provider.id && item.modelID === model),
            cost: info.cost,
            score: bench.scores[`${provider.id}/${model}`] ?? bench.scores[model],
            disabled: provider.id === "opencode" && model.includes("-nano"),
            footer: info.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect: () => {
              choose(provider.id, model, info.id)
            },
          })),
        ),
      ),
      sortBenchOptions,
    )
    function row(item: (typeof list)[number]) {
      const parts = [item.providerName, item.favorite ? "(Favorite)" : undefined, formatPrice(item.cost)]
      return {
        value: item.value,
        title: item.title,
        description: parts.filter((part): part is string => part !== undefined).join(" · "),
        // Score lives in the right-aligned footer so a long model name cannot
        // clip it off the edge of the row.
        footer: item.score !== undefined ? String(item.score) : item.footer,
        disabled: item.disabled,
        onSelect: item.onSelect,
      }
    }
    if (needle) return fuzzysort.go(needle, list, { keys: ["title", "providerName"] }).map((x) => row(x.obj))
    return list.map(row)
  }

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((item) => item.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    if (props.title !== undefined) return props.title
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  function choose(providerID: string, modelID: string, id: string) {
    if (props.onSelect) {
      props.onSelect({ providerID, modelID, id })
      dialog.clear()
      return
    }
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  const tabsHeader = (
    <box flexDirection="row" gap={1}>
      <For each={tabs()}>
        {(tab, index) => {
          const isActive = () => activeTab() === tab
          return (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={
                isActive()
                  ? theme.accent
                  : tabHover() === index()
                    ? theme.backgroundElement
                    : theme.backgroundPanel
              }
              onMouseOver={() => setTabHover(index())}
              onMouseOut={() => setTabHover(undefined)}
              onMouseUp={() => {
                if (renderer.getSelection()?.getSelectedText()) return
                switchTab(tab)
              }}
            >
              <text
                fg={
                  isActive()
                    ? selectedForeground(theme, theme.accent)
                    : tabHover() === index()
                      ? theme.text
                      : theme.textMuted
                }
              >
                {tabLabel(tab)}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )

  return (
    <DialogSelect<ModelValue>
      ref={(ref) => {
        selectRef.current = ref
      }}
      header={tabs().length > 1 ? tabsHeader : undefined}
      options={options()}
      actions={
        selecting()
          ? []
          : [
              {
                command: "model.dialog.provider",
                title: connected() ? "Connect provider" : "View all providers",
                onTrigger() {
                  dialog.replace(() => <DialogProvider />)
                },
              },
              {
                command: "model.dialog.favorite",
                title: "Favorite",
                hidden: !connected(),
                onTrigger: (option) => {
                  local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
                },
              },
            ]
      }
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={selecting() ? undefined : local.model.current()}
    />
  )
}

export function sortModelOptions<T extends { footer?: string; releaseDate: string | number; title: string }>(
  options: T[],
  newestFirst: boolean,
) {
  if (newestFirst) return sortBy(options, [(option) => option.releaseDate, "desc"], (option) => option.title)
  return sortBy(
    options,
    (option) => option.footer !== "Free",
    [(option) => option.releaseDate, "desc"],
    (option) => option.title,
  )
}

export function sortBenchOptions<T extends { score?: number; footer?: string; releaseDate: string | number; title: string }>(
  options: T[],
) {
  // Scored models top first, highest score first; unscored keep the usual
  // free/release/title order at the bottom.
  return sortBy(
    options,
    (option) => (option.score === undefined ? 1 : 0),
    [(option) => option.score ?? -1, "desc"],
    (option) => option.footer !== "Free",
    [(option) => option.releaseDate, "desc"],
    (option) => option.title,
  )
}

export function formatPrice(cost: { input: number; output: number } | undefined) {
  if (cost === undefined) return undefined
  return `$${formatCost(cost.input)} / $${formatCost(cost.output)} per 1M`
}

function formatCost(value: number) {
  return String(Math.round(value * 100) / 100)
}
