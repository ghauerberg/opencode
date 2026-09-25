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
import { ModelPickStore } from "@/modelpick/store"
import { ModelPick } from "@/modelpick"
import type { TaskPromptOps } from "@/tool/task"
import { Advisor } from "./schema"

const DEFAULT_ALLOWANCE = 50
const DEFAULT_STEP_TOOLS = ["read", "write", "edit", "bash", "grep", "glob"]
export const FULL_HISTORY_METADATA_KEY = "advisorFullHistory"

export class AdvisorError extends Schema.TaggedErrorClass<AdvisorError>()("AdvisorError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly runAdvisorReview: (input: {
    sessionID: SessionID
    trigger: Advisor.Trigger
    reason?: string
    promptOps: TaskPromptOps
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

function reviewPrompt(input: {
  trigger: Advisor.Trigger
  stepsSinceLastReview: number
  previousReviews: Advisor.Review[]
  reason?: string
}) {
  return [
    "You are now acting as a senior engineering advisor reviewing the work performed by the primary coding agent.",
    "You have access to the conversation and work history inherited from the primary session up to this review point. Read it carefully before responding.",
    "Your task is not to implement anything. Determine the goal, reconstruct the reasoning and investigation so far, assess the current direction and assumptions, identify loops or missed architectural considerations, and recommend the next useful action or experiment. If the current direction is sound, say so explicitly.",
    "Return concise but technically substantive guidance to the primary agent. Do not modify files, execute implementation commands, or create subagents.",
    "Respond in ordinary plain text, using concise paragraphs or bullets where useful. Do not return JSON or a fixed schema.",
    "",
    `Review trigger: ${input.trigger}`,
    `Steps since previous review: ${input.stepsSinceLastReview}`,
    ...(input.previousReviews.length
      ? [
          "Previous Advisor reviews (supplemental; the full conversation remains primary):",
          ...input.previousReviews.map((review) => `- Cycle ${review.cycle}: ${review.response}`),
        ]
      : []),
    ...(input.reason ? ["", "The user additionally wants the following reviewed:", input.reason] : []),
  ].join("\n")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
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
      promptOps: TaskPromptOps
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

        const configured = yield* getConfiguredModel(input.sessionID)
        const model = configured ?? {
          modelID: ModelV2.ID.make(parent.model?.id ?? "unknown"),
          providerID: ProviderV2.ID.make(parent.model?.providerID ?? "unknown"),
        }

        const child = yield* sessions.fork({ sessionID: input.sessionID }).pipe(Effect.orDie)
        const response = yield* Effect.gen(function* () {
          yield* sessions.setAgentModel({
            sessionID: child.id,
            agent: advisor.name,
            model: { id: model.modelID, providerID: model.providerID },
            time: Date.now(),
          })
          yield* sessions.setPermission({
            sessionID: child.id,
            permission: [
              { permission: "*", pattern: "*", action: "deny" },
              ...["read", "grep", "glob", "list"].map((permission) => ({
                permission,
                pattern: "*" as const,
                action: "allow" as const,
              })),
            ] satisfies PermissionV1.Ruleset,
          })
          const metadata = { ...child.metadata, [FULL_HISTORY_METADATA_KEY]: true }
          yield* sessions.setMetadata({ sessionID: child.id, metadata })
          const prompt = reviewPrompt({
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
              return `Full-history Advisor review unavailable: ${message}. No conversation history was truncated. Use a model with a larger context window or explicitly request a narrower review.`
            }
            return yield* new AdvisorError({ message: `Advisor failed: ${message}` })
          }

          const text = result.parts.findLast((item) => item.type === "text")?.text ?? ""
          return text.trim() || "Advisor returned no usable analysis."
        }).pipe(Effect.ensuring(sessions.remove(child.id).pipe(Effect.ignore)))

        const review: Advisor.Review = {
          sessionID: input.sessionID,
          trigger: input.trigger,
          cycle,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          response,
          createdAt: Date.now(),
        }
        const history = [review, ...current.history].slice(0, 3)
        map.set(input.sessionID, {
          steps: 0,
          cycle,
          lastReview: review,
          history,
          advisorRunning: false,
        })
        return review
      } catch (error) {
        const current = map.get(input.sessionID)
        if (current) {
          map.set(input.sessionID, { ...current, advisorRunning: false })
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
    text: renderAdvice({ trigger: input.review.trigger, cycle: input.review.cycle, review: input.review }),
    synthetic: true,
  } satisfies SessionV1.TextPart)
  return msg
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Agent.node, Session.node, Global.node, ModelPick.node],
})

export { renderAdvice }
export * as Advisor from "."
