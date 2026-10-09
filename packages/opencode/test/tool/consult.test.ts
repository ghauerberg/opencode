import { afterEach, afterAll, describe, expect } from "bun:test"
import * as fs from "fs/promises"
import os from "node:os"
import path from "node:path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit, Fiber, Layer, Queue } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { ConsultTool } from "../../src/tool/consult"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ModelPick } from "@/modelpick"
import { ModelPickStore } from "@/modelpick/store"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const modelConfigDir = path.join(os.tmpdir(), `opencode-consult-models-${process.pid}-${Date.now()}.d`)

afterEach(async () => {
  await disposeAllInstances()
  // The picker tests share one config dir; clear any persisted choice so each
  // test starts from a clean state.
  await fs.rm(path.join(modelConfigDir, "consult-models.json"), { force: true })
})

afterAll(async () => {
  await fs.rm(modelConfigDir, { recursive: true, force: true }).catch(() => {})
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const consultLayer = (globalConfig?: string) =>
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
      ModelPick.node,
      Global.node,
    ]),
    [[Global.node, Global.layerWith({ config: globalConfig ?? modelConfigDir })]],
  )

const it = testEffect(consultLayer())
// Uses the redirected Global config dir so the advisory model is saved under an
// isolated temp location, not the user's real config.
const modelIt = testEffect(consultLayer(modelConfigDir))

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

const seed = Effect.fn("ConsultToolTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Pinned" })
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
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string
  error?: NonNullable<SessionV1.Assistant["error"]>
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "try a flex column", opts?.error)
      }),
  }
}

function reply(
  input: SessionPrompt.PromptInput,
  text: string,
  error?: NonNullable<SessionV1.Assistant["error"]>,
): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "architect",
      agent: input.agent ?? "architect",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
      error,
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

const consultArgs = {
  role: "architect",
  subproblem: "mobile nav overlap",
  confidence: 0.22,
  explanation: "fails at 390px",
  attempted: ["changed z-index"],
  blocker: "overlap persists",
  question: "which boundary owns mobile nav?",
}

const architectConfig = {
  config: {
    agent: {
      architect: {
        model: "test/test-model",
        mode: "subagent" as const,
      },
    },
  },
}

// The model-picker tests exercise the path where the advisory role has no
// pinned model, so a saved or user-picked model must be resolved instead.
const unpinnedArchitectConfig = {
  config: {
    agent: {
      architect: {
        mode: "subagent" as const,
      },
    },
  },
}

describe("tool.consult", () => {
  it.instance("description lists advisory roles for the caller", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      const registry = yield* ToolRegistry.Service
      const description =
        (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === ConsultTool.id)
          ?.description ?? ""
      expect(description).toContain("Advisory roles you can escalate to via the consult tool:")
      expect(description).toContain("- architect:")
      expect(description).toContain("- explore:")
      expect(description).toContain("- general:")
    }),
    architectConfig,
  )

  it.instance("escalates to a configured advisor and returns advice", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* ConsultTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(consultArgs, {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      const child = kids[0]
      expect(child?.agent).toBe("architect")
      expect(child?.parentID).toBe(chat.id)
      expect(result.metadata.sessionId).toBe(child?.id)
      expect(result.metadata.confidence).toBe(0.22)
      expect(result.output).toContain(`<consult role="architect" id="${child?.id}">`)
      expect(result.output).toContain("try a flex column")
      expect(seen?.agent).toBe("architect")
      if (seen?.parts[0]?.type === "text") {
        expect(seen.parts[0].text).toContain("mobile nav overlap")
        expect(seen.parts[0].text).toContain("which boundary owns mobile nav?")
      }
    }),
    architectConfig,
  )

  it.instance("asks permission for the requested role", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* ConsultTool
      const def = yield* tool.init()
      const calls: unknown[] = []

      yield* def.execute(consultArgs, {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps() },
        messages: [],
        metadata: () => Effect.void,
        ask: (input) =>
          Effect.sync(() => {
            calls.push(input)
          }),
      })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "consult",
        patterns: ["architect"],
        always: ["*"],
        metadata: {
          role: "architect",
          subproblem: "mobile nav overlap",
          confidence: 0.22,
        },
      })
    }),
    architectConfig,
  )

  it.instance("denies edit and consult in the advisor child session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* ConsultTool
      const def = yield* tool.init()

      const result = yield* def.execute(consultArgs, {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps() },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })

      const child = yield* sessions.get(result.metadata.sessionId)
      const deny = (permission: string) =>
        child.permission?.some((rule) => rule.permission === permission && rule.action === "deny")
      expect(deny("edit")).toBe(true)
      expect(deny("consult")).toBe(true)
      expect(deny("task")).toBe(true)
    }),
    architectConfig,
  )

  it.instance("attaches screenshot evidence as file parts", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* ConsultTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      yield* def.execute(
        {
          ...consultArgs,
          evidence: {
            url: "http://localhost:3000/session",
            viewport: "390x844",
            screenshots: ["artifacts/shot.png"],
            consoleErrors: ["TypeError: x is not a function"],
          },
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const parts = seen?.parts ?? []
      expect(parts.some((part) => part.type === "file" && part.mime === "image/png")).toBe(true)
      expect(parts.some((part) => part.type === "file" && part.filename === "artifacts/shot.png")).toBe(true)
      if (parts[0]?.type === "text") {
        expect(parts[0].text).toContain("TypeError: x is not a function")
        expect(parts[0].text).toContain("viewport: 390x844")
      }
    }),
    architectConfig,
  )

  it.instance("fails for an unknown escalation role", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* ConsultTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute({ ...consultArgs, role: "does-not-exist" }, {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected consult failure")
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toContain('Unknown escalation role: "does-not-exist"')
    }),
  )

  it.instance("surfaces advisor errors", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* ConsultTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(consultArgs, {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: stubOps({
              text: "",
              error: new SessionV1.APIError({ message: "Network connection lost", isRetryable: false }).toObject(),
            }),
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected consult failure")
      const child = (yield* sessions.children(chat.id))[0]
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toBe(`Consultation failed (${child?.id}): Network connection lost`)
    }),
    architectConfig,
  )

  it.instance("uses the advisor's configured model", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* ConsultTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      yield* def.execute(consultArgs, {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })

      expect(seen?.model).toEqual({
        providerID: ProviderV2.ID.make("advisor-provider"),
        modelID: ModelV2.ID.make("advisor-model"),
      })
    }),
    {
      config: {
        agent: {
          architect: {
            model: "advisor-provider/advisor-model",
            mode: "subagent",
          },
        },
      },
    },
  )

  modelIt.instance("prompts the user for the advisory model once and saves the choice", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const modelpick = yield* ModelPick.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* ConsultTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      const fiber = yield* def
        .execute(consultArgs, {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        .pipe(Effect.forkScoped)

      const item = yield* pendingModelPick(modelpick)
      yield* modelpick.reply({
        requestID: item.id,
        answer: { providerID: "pick-prov", modelID: "pick-model" },
      })

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.confidence).toBe(0.22)
      expect(seen?.model).toEqual({
        providerID: ProviderV2.ID.make("pick-prov"),
        modelID: ModelV2.ID.make("pick-model"),
      })

      const child = yield* sessions.get(result.metadata.sessionId)
      expect(child?.agent).toBe("architect")

      // The choice is persisted for this role and no new request stays pending.
      yield* Effect.sleep("20 millis")
      expect((yield* modelpick.list())).toHaveLength(0)
      const saved = yield* ModelPickStore.find(modelConfigDir, "architect")
      expect(saved).toEqual({ providerID: "pick-prov", modelID: "pick-model" })
    }),
    unpinnedArchitectConfig,
  )

  modelIt.instance("reuses a saved advisory model instead of prompting", () =>
    Effect.gen(function* () {
      const modelpick = yield* ModelPick.Service
      yield* ModelPickStore.save(modelConfigDir, "architect", {
        providerID: "saved-prov",
        modelID: "saved-model",
      })

      const { chat, assistant } = yield* seed()
      const tool = yield* ConsultTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      // Synchronous execution: a saved model means no picker is triggered.
      yield* def.execute(consultArgs, {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })

      expect(seen?.model).toEqual({
        providerID: ProviderV2.ID.make("saved-prov"),
        modelID: ModelV2.ID.make("saved-model"),
      })
      expect((yield* modelpick.list())).toHaveLength(0)
    }),
    unpinnedArchitectConfig,
  )

  modelIt.instance("fails when the user dismisses the model picker", () =>
    Effect.gen(function* () {
      const modelpick = yield* ModelPick.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* ConsultTool
      const def = yield* tool.init()

      const fiber = yield* def
        .execute(consultArgs, {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        .pipe(Effect.forkScoped)

      const item = yield* pendingModelPick(modelpick)
      yield* modelpick.reject(item.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected consult to fail")
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toContain("Advisory model not selected")
    }),
    unpinnedArchitectConfig,
  )
})
