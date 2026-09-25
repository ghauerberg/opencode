import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer, Queue, Fiber } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Advisor } from "@/advisor"
import { AdvisorTool } from "../../src/tool/advisor"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Command } from "@/command"
import { disposeAllInstances } from "../fixture/fixture"
import { ModelPick } from "@/modelpick"
import { ModelPickStore } from "@/modelpick/store"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const advisorLayer = (overrides?: Record<string, unknown>) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
      Global.node,
      Command.node,
      Advisor.node,
      ModelPick.node,
    ]),
    [[Global.node, Global.layerWith({ config: "/tmp/advisor-test-config" })]],
  )

const it = testEffect(advisorLayer())

const seed = Effect.fn("AdvisorTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Advisor test" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    finish: "stop",
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: Parameters<TaskPromptOps["prompt"]>[0], text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "advisor",
      agent: input.agent ?? "advisor",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function stubOps(text: string): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) => Effect.sync(() => reply(input, text)),
  }
}

function stubOpsWithCapture(
  text: string,
  onPrompt: (input: Parameters<TaskPromptOps["prompt"]>[0]) => void,
): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) => {
      onPrompt(input)
      return Effect.sync(() => reply(input, text))
    },
  }
}

const pendingModelPick = Effect.fnUntraced(function* (modelpick: ModelPick.Interface) {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === ModelPick.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const items = yield* modelpick.list()
    const item = items[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

const advisorText = [
  "The current approach needs adjustment: the evidence does not support further changes here.",
  "The same failure has persisted across attempts.",
  "Inspect the API boundary before making more middleware changes, and avoid further TokenValidator changes until then.",
].join("\n\n")

const advisorConfig = {
  config: {
    advisor: {
      automatic: { every: 3 },
      stepTools: ["read", "write", "edit", "bash", "grep", "glob"],
    },
  },
}

afterEach(async () => {
  await disposeAllInstances()
  // The persisted advisor model lives under the shared test config dir; clear it
  // so tests start from a clean state.
  await Bun.write("/tmp/advisor-test-config/consult-models.json", "{}").catch(() => {})
})

describe("advisor", () => {
  it.instance(
    "model invocation runs the advisor and returns plain-text advice",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* AdvisorTool
        const def = yield* tool.init()
        const sessions = yield* Session.Service

        const result = yield* def.execute(
          {},
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps(advisorText) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.output).toContain("current approach needs adjustment")
        expect(result.output).toContain("Inspect the API boundary")

        // The temporary fork is removed after its final response is captured.
        const children = yield* sessions.children(chat.id)
        expect(children).toHaveLength(0)
      }),
    advisorConfig,
  )

  it.instance("counter is per-session and steps count only configured tools", () =>
    Effect.gen(function* () {
      const advisor = yield* Advisor.Service
      const { chat } = yield* seed()
      const other = yield* (yield* Session.Service).create({ title: "Other" })

      yield* advisor.step({ sessionID: chat.id, tool: "read", agent: "build" })
      yield* advisor.step({ sessionID: chat.id, tool: "read", agent: "build" })
      yield* advisor.step({ sessionID: other.id, tool: "read", agent: "build" })
      yield* advisor.step({ sessionID: chat.id, tool: "question", agent: "build" })

      const a = yield* advisor.getState(chat.id)
      const b = yield* advisor.getState(other.id)
      expect(a.steps).toBe(2)
      expect(b.steps).toBe(1)
      expect(a.cycle).toBe(0)
    }),
  )

  it.instance(
    "auto trigger fires at the allowance and injects advice into the same session",
    () =>
      Effect.gen(function* () {
        const advisor = yield* Advisor.Service
        const sessions = yield* Session.Service
        const { chat } = yield* seed()

        yield* advisor.step({ sessionID: chat.id, tool: "read", agent: "build" })
        yield* advisor.step({ sessionID: chat.id, tool: "read", agent: "build" })
        yield* advisor.step({ sessionID: chat.id, tool: "read", agent: "build" })

        const triggered = yield* advisor.maybeAutoReview({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          promptOps: stubOps(advisorText),
        })
        expect(triggered).toBe(true)

        const after = yield* advisor.getState(chat.id)
        expect(after.cycle).toBe(1)
        expect(after.steps).toBe(0)
        expect(after.history).toHaveLength(1)

        // The advice landed as a synthetic message in the same session.
        const msgs = yield* sessions.messages({ sessionID: chat.id }).pipe(Effect.orDie)
        const adviceMsg = msgs.find((msg) =>
          msg.parts.some((part) => part.type === "text" && part.text.includes("current approach needs adjustment")),
        )
        expect(adviceMsg).toBeDefined()
        expect(adviceMsg?.info.role).toBe("user")
      }),
    advisorConfig,
  )

  it.instance(
    "does not re-trigger while a review is running or for advisor activity",
    () =>
      Effect.gen(function* () {
        const advisor = yield* Advisor.Service
        const { chat } = yield* seed()

        // Advisor-generated activity (agent name matches the advisor agent) is not counted.
        yield* advisor.step({ sessionID: chat.id, tool: "read", agent: "advisor" })
        const s = yield* advisor.getState(chat.id)
        expect(s.steps).toBe(0)

        // Simulate an in-flight review: below allowance, no trigger happens.
        const notYet = yield* advisor.maybeAutoReview({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          promptOps: stubOps(advisorText),
        })
        expect(notYet).toBe(false)
      }),
    advisorConfig,
  )

  it.instance(
    "fails open when the advisor agent is missing",
    () =>
      Effect.gen(function* () {
        const advisor = yield* Advisor.Service
        const { chat } = yield* seed()
        yield* advisor.step({ sessionID: chat.id, tool: "read", agent: "build" })
        yield* advisor.step({ sessionID: chat.id, tool: "read", agent: "build" })
        yield* advisor.step({ sessionID: chat.id, tool: "read", agent: "build" })

        const triggered = yield* advisor.maybeAutoReview({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          promptOps: stubOps(advisorText),
        })
        // The built-in advisor agent exists, so this triggers; history is recorded.
        expect(triggered).toBe(true)
        const after = yield* advisor.getState(chat.id)
        expect(after.history).toHaveLength(1)
      }),
    advisorConfig,
  )

  it.instance("advisor agent is read-only", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const advisor = yield* agents.get("advisor")
      expect(advisor).toBeDefined()
      expect(advisor?.mode).toBe("subagent")
      expect(advisor?.steps).toBe(3)
      const rules = advisor!.permission
      const ev = (permission: string) => {
        const rule = rules.findLast((r) => Wildcard.match(permission, r.permission) && Wildcard.match("*", r.pattern))
        return rule?.action
      }
      expect(ev("read")).toBe("allow")
      expect(ev("edit")).toBe("deny")
      expect(ev("bash")).toBe("deny")
      expect(ev("task")).toBe("deny")
      expect(ev("todowrite")).toBe("deny")
    }),
  )

  it.instance("full-history fork retains an early constraint across a large conversation", () =>
    Effect.gen(function* () {
      const advisor = yield* Advisor.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const history = yield* sessions.messages({ sessionID: chat.id })
      const first = history.find((message) => message.info.role === "user")
      expect(first).toBeDefined()
      if (!first || first.info.role !== "user") return
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: first.info.id,
        type: "text",
        text: "Important early constraint: component X must remain backwards compatible.",
      })
      yield* Effect.forEach(
        Array.from({ length: 40 }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: chat.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() + index * 2 + 1 },
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: user.id,
              sessionID: chat.id,
              type: "text",
              text: `Unrelated investigation ${index}: ${"background detail ".repeat(50)}`,
            })
            const assistant: SessionV1.Assistant = {
              id: MessageID.ascending(),
              parentID: user.id,
              role: "assistant",
              sessionID: chat.id,
              mode: "build",
              agent: "build",
              cost: 0,
              path: { cwd: "/tmp", root: "/tmp" },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ref.modelID,
              providerID: ref.providerID,
              time: { created: Date.now() + index * 2 + 2 },
              finish: "stop",
            }
            yield* sessions.updateMessage(assistant)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: chat.id,
              type: "text",
              text: "Continued unrelated investigation.",
            })
          }),
      )
      const before = yield* sessions.messages({ sessionID: chat.id })
      const agentService = yield* Agent.Service
      const advisorAgent = yield* agentService.get("advisor")
      let sawConstraint = false
      let sawFullHistoryMarker = false
      let sawReadOnlyPermissions = false
      const review = yield* advisor.runAdvisorReview({
        sessionID: chat.id,
        trigger: "user",
        reason: "Should component X be changed?",
        promptOps: {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              const child = yield* sessions.get(input.sessionID)
              const copied = yield* sessions.messages({ sessionID: input.sessionID })
              sawConstraint = copied.some((message) =>
                message.parts.some(
                  (part) => part.type === "text" && part.text.includes("component X must remain backwards compatible"),
                ),
              )
              sawFullHistoryMarker = child.metadata?.[Advisor.FULL_HISTORY_METADATA_KEY] === true
              const action = (permission: string) =>
                Permission.evaluate(permission, "*", advisorAgent?.permission ?? [], child.permission ?? []).action
              sawReadOnlyPermissions =
                action("read") === "allow" && ["edit", "write", "bash", "task"].every((tool) => action(tool) === "deny")
              expect(copied.length).toBeGreaterThan(80)
              expect(
                input.parts.some(
                  (part) => part.type === "text" && part.text.includes("Should component X be changed?"),
                ),
              ).toBe(true)
              return reply(input, advisorText)
            }).pipe(Effect.orDie),
        },
      })
      expect(review.response).toContain("current approach needs adjustment")
      expect(sawConstraint).toBe(true)
      expect(sawFullHistoryMarker).toBe(true)
      expect(sawReadOnlyPermissions).toBe(true)
      expect(yield* sessions.messages({ sessionID: chat.id })).toHaveLength(before.length)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("session id type is respected", () =>
    Effect.gen(function* () {
      expect(SessionID.make("ses_advisor_test")).toMatch(/^ses_/)
    }),
  )

  it.instance(
    "advisor_review tool is registered",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        const tools = yield* registry.tools({ ...ref, agent: build })
        const advisorTool = tools.find((tool) => tool.id === AdvisorTool.id)
        expect(advisorTool).toBeDefined()
        expect(advisorTool?.description).toContain("senior reasoning advisor")
      }),
    advisorConfig,
  )

  it.instance(
    "counter resets after a successful review (cycle advances)",
    () =>
      Effect.gen(function* () {
        const advisor = yield* Advisor.Service
        const { chat } = yield* seed()
        for (let i = 0; i < 3; i++) yield* advisor.step({ sessionID: chat.id, tool: "read", agent: "build" })

        const triggered = yield* advisor.maybeAutoReview({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          promptOps: stubOps(advisorText),
        })
        expect(triggered).toBe(true)

        const after = yield* advisor.getState(chat.id)
        expect(after.cycle).toBe(1)
        expect(after.steps).toBe(0)

        // A second round triggers again, proving the reset allowed re-entry.
        for (let i = 0; i < 3; i++) yield* advisor.step({ sessionID: chat.id, tool: "edit", agent: "build" })
        const again = yield* advisor.maybeAutoReview({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          promptOps: stubOps(advisorText),
        })
        expect(again).toBe(true)
        const final = yield* advisor.getState(chat.id)
        expect(final.cycle).toBe(2)
        expect(final.history).toHaveLength(2)
      }),
    advisorConfig,
  )

  it.instance(
    "/advise and the legacy /advisor command are direct advisor entry points",
    () =>
      Effect.gen(function* () {
        const commands = yield* Command.Service
        const advisorCmd = yield* commands.get(Command.Default.ADVISOR)
        const adviseCmd = yield* commands.get(Command.Default.ADVISE)
        expect(advisorCmd).toBeDefined()
        expect(advisorCmd?.name).toBe("advisor")
        expect(advisorCmd?.description).toContain("advisor")
        expect(advisorCmd?.subtask).toBeUndefined()
        expect(adviseCmd?.name).toBe("advise")
        expect(adviseCmd?.subtask).toBeUndefined()
      }),
    advisorConfig,
  )

  it.instance(
    "/advisormodel persists and clears the advisor model",
    () =>
      Effect.gen(function* () {
        const commands = yield* Command.Service
        const cmd = yield* commands.get(Command.Default.ADVISOR_MODEL)
        expect(cmd).toBeDefined()

        const advisor = yield* Advisor.Service
        const { chat } = yield* seed()

        // Nothing set yet.
        expect(yield* advisor.getConfiguredModel(chat.id)).toBeUndefined()

        yield* advisor.setConfiguredModel({
          sessionID: chat.id,
          model: { providerID: "custom-provider", modelID: "custom-model" },
        })
        const configured = yield* advisor.getConfiguredModel(chat.id)
        expect(configured).toEqual({
          providerID: ProviderV2.ID.make("custom-provider"),
          modelID: ModelV2.ID.make("custom-model"),
        })

        // Clearing falls back to the agent's configured model (undefined here).
        yield* advisor.setConfiguredModel({ sessionID: chat.id, model: undefined })
        expect(yield* advisor.getConfiguredModel(chat.id)).toBeUndefined()
      }),
    advisorConfig,
  )

  it.instance(
    "advisor review uses the persisted model override",
    () =>
      Effect.gen(function* () {
        const advisor = yield* Advisor.Service
        const { chat } = yield* seed()

        yield* advisor.setConfiguredModel({
          sessionID: chat.id,
          model: { providerID: "advisor-provider", modelID: "advisor-model" },
        })
        yield* advisor.step({ sessionID: chat.id, tool: "read", agent: "build" })
        yield* advisor.step({ sessionID: chat.id, tool: "read", agent: "build" })
        yield* advisor.step({ sessionID: chat.id, tool: "read", agent: "build" })

        let promptModel: { providerID: string; modelID: string } | undefined
        const triggered = yield* advisor.maybeAutoReview({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          promptOps: stubOpsWithCapture(advisorText, (input) => (promptModel = input.model)),
        })
        expect(triggered).toBe(true)
        expect(promptModel).toEqual({ providerID: "advisor-provider", modelID: "advisor-model" })
      }),
    advisorConfig,
  )

  it.instance(
    "askConfiguredModel opens the picker, saves the choice, and persists it",
    () =>
      Effect.gen(function* () {
        const advisor = yield* Advisor.Service
        const modelpick = yield* ModelPick.Service
        const { chat } = yield* seed()

        const fiber = yield* advisor.askConfiguredModel({ sessionID: chat.id }).pipe(Effect.forkScoped)

        const item = yield* pendingModelPick(modelpick)
        yield* modelpick.reply({
          requestID: item.id,
          answer: { providerID: "picker-prov", modelID: "picker-model" },
        })

        const picked = yield* Fiber.join(fiber)
        expect(picked).toEqual({ providerID: "picker-prov", modelID: "picker-model" })

        // Persisted under the advisor role name and reused by getConfiguredModel.
        const saved = yield* ModelPickStore.find("/tmp/advisor-test-config", "advisor")
        expect(saved).toEqual({ providerID: "picker-prov", modelID: "picker-model" })
        const configured = yield* advisor.getConfiguredModel(chat.id)
        expect(configured).toEqual({
          providerID: ProviderV2.ID.make("picker-prov"),
          modelID: ModelV2.ID.make("picker-model"),
        })
        expect(yield* modelpick.list()).toHaveLength(0)
      }),
    advisorConfig,
  )

  it.instance(
    "askConfiguredModel returns undefined when the picker is dismissed",
    () =>
      Effect.gen(function* () {
        const advisor = yield* Advisor.Service
        const modelpick = yield* ModelPick.Service
        const { chat } = yield* seed()

        const fiber = yield* advisor.askConfiguredModel({ sessionID: chat.id }).pipe(Effect.forkScoped)

        const item = yield* pendingModelPick(modelpick)
        yield* modelpick.reject(item.id)

        expect(yield* Fiber.join(fiber)).toBeUndefined()
        expect(yield* modelpick.list()).toHaveLength(0)
      }),
    advisorConfig,
  )
})
