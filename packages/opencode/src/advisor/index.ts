import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema, Exit, Cause } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@opencode-ai/core/global"
import { Database } from "@opencode-ai/core/database/database"
import { MessageV2 } from "@/session/message-v2"
import { ModelPickStore } from "@/modelpick/store"
import { ModelPick } from "@/modelpick"
import type { TaskPromptOps } from "@/tool/task"
import { Advisor } from "./schema"

const DEFAULT_ALLOWANCE = 50
const DEFAULT_STEP_TOOLS = ["read", "write", "edit", "bash", "grep", "glob"]

export class AdvisorError extends Schema.TaggedErrorClass<AdvisorError>()("AdvisorError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly runAdvisorReview: (input: {
    sessionID: SessionID
    trigger: Advisor.Trigger
    reason?: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    promptOps: TaskPromptOps
    onChild?: (input: {
      sessionID: SessionID
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    }) => Effect.Effect<void>
  }) => Effect.Effect<Advisor.Review, AdvisorError>
  readonly step: (input: { sessionID: SessionID; tool: string; agent: string }) => Effect.Effect<void>
  readonly reset: (sessionID: SessionID) => Effect.Effect<void>
  readonly getState: (sessionID: SessionID) => Effect.Effect<Advisor.State>
  readonly maybeAutoReview: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    promptOps: TaskPromptOps
  }) => Effect.Effect<boolean>
  /** Model chosen for the advisor, or undefined if the agent's configured model applies. */
  readonly getConfiguredModel: (
    sessionID: SessionID,
  ) => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID } | undefined>
  /** Persist a model override for the advisor (or clear it with `undefined`). */
  readonly setConfiguredModel: (input: {
    sessionID: SessionID
    model: { providerID: string; modelID: string } | undefined
  }) => Effect.Effect<void>
  /** Open the model picker for the advisor and persist the chosen model. Returns undefined if dismissed. */
  readonly askConfiguredModel: (input: {
    sessionID: SessionID
  }) => Effect.Effect<{ providerID: string; modelID: string } | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Advisor") {}

function renderAdvice(input: { trigger: Advisor.Trigger; cycle: number; review: Advisor.Review }): string {
  return [
    `ADVISOR REVIEW (${input.trigger}, cycle ${input.cycle})`,
    "",
    input.review.response,
    "",
    "This is advisory feedback. Use your own engineering judgment.",
  ].join("\n")
}

/**
 * Serialize the session's visible history (everything since the last
 * compaction, with the compaction summary standing in for earlier work) into a
 * single transcript, so the advisor subagent receives the same context the
 * primary agent sees in one clean prompt without copying messages.
 */
function renderTranscript(history: SessionV1.WithParts[]): string {
  const lines: string[] = []
  for (const message of history) {
    const info = message.info
    if (info.role === "user") {
      lines.push(`=== user (agent=${info.agent}) ===`)
      for (const part of message.parts) {
        if (part.type === "text") {
          lines.push(part.synthetic ? `[synthetic user note] ${part.text}` : part.text)
        } else if (part.type === "file") {
          lines.push(`[attachment: ${part.filename ?? part.mime}]`)
        } else if (part.type === "subtask") {
          lines.push(`[subtask delegated to ${part.agent}] ${part.description}\n${part.prompt}`)
        } else if (part.type === "compaction") {
          lines.push("[compaction: earlier history was summarized]")
        }
      }
    } else {
      const head = [`agent=${info.agent}`]
      if (info.finish) head.push(`finish=${info.finish}`)
      if (info.summary) head.push("summary=true")
      if (info.error) head.push(`error=${info.error.name}`)
      lines.push(`=== assistant (${head.join(", ")}) ===`)
      for (const part of message.parts) {
        if (part.type === "text") {
          lines.push(part.synthetic ? `[synthetic assistant note] ${part.text}` : part.text)
        } else if (part.type === "tool") {
          lines.push(`[tool ${part.tool}] status=${part.state.status}`)
          lines.push(`input: ${JSON.stringify(part.state.input)}`)
          if (part.state.status === "completed") lines.push(`output:\n${part.state.output}`)
          if (part.state.status === "error") lines.push(`error: ${part.state.error}`)
        } else if (part.type === "compaction") {
          lines.push("[compaction: earlier history was summarized]")
        }
      }
    }
  }
  return lines.join("\n")
}

function advisorPrompt(input: {
  transcript: string
  trigger: Advisor.Trigger
  stepsSinceLastReview: number
  previousReviews: Advisor.Review[]
  reason?: string
}) {
  const body = [
    "You are now acting as a senior engineering advisor reviewing the work performed by the primary coding agent.",
    "The visible conversation transcript of the primary session up to this review point is provided above: everything since the last compaction, with the compaction summary standing in for earlier work — the same view the primary agent gets. Read it carefully before responding.",
    "Your task is not to implement anything. Determine the goal, reconstruct the reasoning and investigation so far, assess the current direction and assumptions, identify loops or missed architectural considerations, and recommend the next useful action or experiment. If the current direction is sound, say so explicitly.",
    "Return concise but technically substantive guidance to the primary agent. Do not modify files, execute implementation commands, or create subagents.",
    "Respond in ordinary plain text, using concise paragraphs or bullets where useful. Do not return JSON or a fixed schema.",
    "",
    `Review trigger: ${input.trigger}`,
    `Steps since previous review: ${input.stepsSinceLastReview}`,
    ...(input.previousReviews.length
      ? [
          "Previous Advisor reviews (supplemental; the full transcript remains primary):",
          ...input.previousReviews.map((review) => `- Cycle ${review.cycle}: ${review.response}`),
        ]
      : []),
    ...(input.reason ? ["", "The user additionally wants the following reviewed:", input.reason] : []),
  ].join("\n")
  if (input.transcript.trim().length === 0) return body
  return [
    "Conversation transcript of the session under review (visible history since the last compaction):",
    "<<<transcript",
    input.transcript,
    "transcript>>>",
    "",
    body,
  ].join("\n")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const database = yield* Database.Service
    const global = yield* Global.Service
    const modelpick = yield* ModelPick.Service

    const state = yield* InstanceState.make<Map<SessionID, Advisor.State>>(
      Effect.fn("Advisor.state")(function* () {
        const map = new Map<SessionID, Advisor.State>()
        yield* Effect.addFinalizer(() => Effect.sync(() => map.clear()))
        return map
      }),
    )

    const settings = Effect.fnUntraced(function* () {
      const cfg = yield* config.get()
      const advisorCfg = cfg.advisor ?? {}
      const enabled = advisorCfg.enabled ?? true
      const agentName = advisorCfg.agent ?? "advisor"
      const every = advisorCfg.automatic?.every ?? DEFAULT_ALLOWANCE
      const stepTools = advisorCfg.stepTools ?? DEFAULT_STEP_TOOLS
      const failMode = advisorCfg.failMode ?? "continue"
      return { enabled, agentName, every, stepTools, failMode }
    })

    const getConfiguredModel: Interface["getConfiguredModel"] = Effect.fn("Advisor.getConfiguredModel")(function* (
      sessionID: SessionID,
    ) {
      const s = yield* settings()
      const persisted = yield* ModelPickStore.find(global.config, s.agentName)
      if (persisted) {
        return {
          providerID: ProviderV2.ID.make(persisted.providerID),
          modelID: ModelV2.ID.make(persisted.modelID),
        }
      }
      const advisor = yield* agents.get(s.agentName)
      return advisor?.model
    })

    const setConfiguredModel: Interface["setConfiguredModel"] = Effect.fn("Advisor.setConfiguredModel")(
      function* (input: { sessionID: SessionID; model: { providerID: string; modelID: string } | undefined }) {
        void input.sessionID
        const s = yield* settings()
        if (!input.model) {
          yield* ModelPickStore.clear(global.config, s.agentName).pipe(Effect.orDie)
          return
        }
        yield* ModelPickStore.save(global.config, s.agentName, input.model).pipe(Effect.orDie)
      },
    )

    const askConfiguredModel: Interface["askConfiguredModel"] = Effect.fn("Advisor.askConfiguredModel")(
      function* (input: { sessionID: SessionID }) {
        const s = yield* settings()
        const picked = yield* modelpick
          .ask({
            sessionID: input.sessionID,
            role: s.agentName,
          })
          .pipe(Effect.catchTag("ModelPickRejectedError", () => Effect.succeed(undefined)))
        if (!picked) return undefined
        yield* ModelPickStore.save(global.config, s.agentName, picked).pipe(Effect.orDie)
        return picked
      },
    )

    const runAdvisorReview: Interface["runAdvisorReview"] = Effect.fn("Advisor.runAdvisorReview")(function* (input: {
      sessionID: SessionID
      trigger: Advisor.Trigger
      reason?: string
      model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      promptOps: TaskPromptOps
      onChild?: (input: {
        sessionID: SessionID
        model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) => Effect.Effect<void>
    }) {
      const s = yield* settings()
      if (!s.enabled) return yield* new AdvisorError({ message: "Advisor is disabled in config" })

      const advisor = yield* agents.get(s.agentName)
      if (!advisor) {
        return yield* new AdvisorError({
          message: `No advisor agent configured. Add an agent named "${s.agentName}" (mode: subagent) or set advisor.agent in config.`,
        })
      }

      const map = yield* InstanceState.get(state)
      const current = map.get(input.sessionID) ?? { ...Advisor.defaultState }
      if (current.advisorRunning) {
        return yield* new AdvisorError({ message: "An advisor review is already running for this session" })
      }
      map.set(input.sessionID, { ...current, advisorRunning: true })

      const cycle = current.cycle + 1

      try {
        const parent = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

        // Precedence: advisor model chosen via /advisor-model (stored over agent
        // config), then the caller's default, then the parent session's model.
        // A configured advisor model intentionally shadows input.model, which
        // callers pass as a convenience default rather than a user choice.
        const configured = yield* getConfiguredModel(input.sessionID)
        const model = configured ??
          input.model ?? {
            modelID: ModelV2.ID.make(parent.model?.id ?? "unknown"),
            providerID: ProviderV2.ID.make(parent.model?.providerID ?? "unknown"),
          }

        // The advisor sees the same visible history the main loop gives the model:
        // everything since the last compaction, with the compaction summary standing
        // in for earlier work. Never serialize the full pre-compaction archive here.
        const history = yield* MessageV2.filterCompactedEffect(input.sessionID).pipe(
          Effect.provideService(Database.Service, database),
        )
        const permission: PermissionV1.Ruleset = [
          { permission: "*", pattern: "*", action: "deny" },
          ...["read", "grep", "glob", "list"].map((rule) => ({
            permission: rule,
            pattern: "*" as const,
            action: "allow" as const,
          })),
        ]
        const child = yield* sessions.create({
          parentID: input.sessionID,
          title: `Advisor review (@${advisor.name} subagent)`,
          agent: advisor.name,
          model: { id: model.modelID, providerID: model.providerID },
          permission,
          metadata: { advisorTemporary: true },
        }).pipe(Effect.orDie)
        // Everything after creation runs under the archive finalizer so a
        // failure anywhere (hook, transcript, model call, interruption) still
        // archives the temporary child instead of leaking it into the session
        // list.
        const response = yield* Effect.gen(function* () {
          if (input.onChild) yield* input.onChild({ sessionID: child.id, model })
          const prompt = advisorPrompt({
            transcript: renderTranscript(history),
            trigger: input.trigger,
            stepsSinceLastReview: current.steps,
            previousReviews: current.history,
            reason: input.reason,
          })
          const parts = yield* input.promptOps.resolvePromptParts(prompt)
          const result = yield* input.promptOps.prompt({
            messageID: MessageID.ascending(),
            sessionID: child.id,
            model: { modelID: model.modelID, providerID: model.providerID },
            agent: advisor.name,
            variant: advisor.variant,
            parts,
          })

          if (result.info.role === "assistant" && result.info.error) {
            const message =
              "message" in result.info.error.data && typeof result.info.error.data.message === "string"
                ? result.info.error.data.message
                : result.info.error.name
            if (result.info.error.name === "ContextOverflowError") {
              return `Advisor review unavailable: the visible session history exceeds the model's context window. No history was truncated. Use a model with a larger context window, or compact the session and review again.`
            }
            return yield* new AdvisorError({ message: `Advisor failed: ${message}` })
          }

          const text = result.parts.findLast((item) => item.type === "text")?.text ?? ""
          return text.trim() || "Advisor returned no usable analysis."
        }).pipe(Effect.ensuring(sessions.setArchived({ sessionID: child.id })))

        const review: Advisor.Review = {
          sessionID: input.sessionID,
          trigger: input.trigger,
          cycle,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          response,
          createdAt: Date.now(),
        }
        const reviews = [review, ...current.history].slice(0, 3)
        map.set(input.sessionID, {
          steps: 0,
          cycle,
          lastReview: review,
          history: reviews,
          advisorRunning: false,
        })
        return review
      } catch (error) {
        const entry = map.get(input.sessionID)
        if (entry) {
          map.set(input.sessionID, { ...entry, advisorRunning: false })
        }
        if (error instanceof AdvisorError) return yield* error
        return yield* new AdvisorError({ message: error instanceof Error ? error.message : String(error) })
      }
    })

    const step: Interface["step"] = Effect.fn("Advisor.step")(function* (input: {
      sessionID: SessionID
      tool: string
      agent: string
    }) {
      const s = yield* settings()
      if (!s.enabled) return
      if (input.agent === s.agentName) return
      if (!s.stepTools.includes(input.tool)) return

      const map = yield* InstanceState.get(state)
      const current = map.get(input.sessionID) ?? { ...Advisor.defaultState }
      if (current.advisorRunning) return
      map.set(input.sessionID, { ...current, steps: current.steps + 1 })
    })

    const reset: Interface["reset"] = Effect.fn("Advisor.reset")(function* (sessionID: SessionID) {
      const map = yield* InstanceState.get(state)
      const current = map.get(sessionID) ?? { ...Advisor.defaultState }
      map.set(sessionID, { ...current, steps: 0 })
    })

    const getState: Interface["getState"] = Effect.fn("Advisor.getState")(function* (sessionID: SessionID) {
      const map = yield* InstanceState.get(state)
      return map.get(sessionID) ?? { ...Advisor.defaultState }
    })

    const maybeAutoReview: Interface["maybeAutoReview"] = Effect.fn("Advisor.maybeAutoReview")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      promptOps: TaskPromptOps
    }) {
      const s = yield* settings()
      if (!s.enabled) return false
      if (s.failMode === "pause") return false
      if (s.agentName === input.agent) return false

      const map = yield* InstanceState.get(state)
      const current = map.get(input.sessionID) ?? { ...Advisor.defaultState }
      if (current.advisorRunning) return false
      if (current.steps < s.every) return false

      yield* Effect.logInfo("auto advisor review", { "session.id": input.sessionID, steps: current.steps })
      const exit = yield* runAdvisorReview({
        sessionID: input.sessionID,
        trigger: "automatic",
        promptOps: input.promptOps,
      }).pipe(Effect.exit)
      if (Exit.isFailure(exit)) {
        yield* Effect.logWarning("auto advisor review failed, continuing", {
          "session.id": input.sessionID,
          cause: String(Cause.squash(exit.cause)),
        })
        // Restart the step counter so the automatic review retries after the
        // next full step window instead of re-triggering on every subsequent
        // step until it happens to succeed.
        map.set(input.sessionID, { ...(map.get(input.sessionID) ?? current), steps: 0, advisorRunning: false })
        return false
      }
      const review = exit.value
      yield* injectAdvice({
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        review,
      }).pipe(Effect.provideService(Session.Service, sessions))
      return true
    })

    return Service.of({
      runAdvisorReview,
      step,
      reset,
      getState,
      maybeAutoReview,
      getConfiguredModel,
      setConfiguredModel,
      askConfiguredModel,
    })
  }),
)

export const injectAdvice = Effect.fn("Advisor.injectAdvice")(function* (input: {
  sessionID: SessionID
  agent: string
  model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  review: Advisor.Review
}) {
  const sessions = yield* Session.Service
  const msg: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.agent,
    model: input.model,
  }
  yield* sessions.updateMessage(msg)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: input.sessionID,
    type: "text",
    // Not synthetic: the advice must render in the main session. Synthetic
    // text parts are hidden by the TUI and CLI transcripts.
    text: renderAdvice({ trigger: input.review.trigger, cycle: input.review.cycle, review: input.review }),
  } satisfies SessionV1.TextPart)
  return msg
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Agent.node, Session.node, Database.node, Global.node, ModelPick.node],
})

export { renderAdvice }
export * as Advisor from "."
