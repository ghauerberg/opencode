import { Effect, Schema, Types } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./consult.txt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import type { TaskPromptOps } from "./task"
import { Config } from "@/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Global } from "@opencode-ai/core/global"
import { ModelPick } from "@/modelpick"
import { ModelPickStore } from "@/modelpick/store"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import { pathToFileURL } from "url"

const id = "consult"

const Confidence = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(1))

const Evidence = Schema.Struct({
  url: Schema.optional(Schema.String),
  viewport: Schema.optional(Schema.String),
  screenshots: Schema.optional(Schema.Array(Schema.String)),
  consoleErrors: Schema.optional(Schema.Array(Schema.String)),
  networkFailures: Schema.optional(Schema.Array(Schema.String)),
  domSnapshot: Schema.optional(Schema.String),
  reproduction: Schema.optional(Schema.Array(Schema.String)),
  relevantFiles: Schema.optional(Schema.Array(Schema.String)),
})

export const Parameters = Schema.Struct({
  role: Schema.String.annotate({ description: "The advisory agent to escalate to (e.g. 'architect')" }),
  subproblem: Schema.String.annotate({ description: "A short name for the current subproblem" }),
  confidence: Confidence.annotate({
    description: "Your 0-1 confidence that the current approach will succeed on its own",
  }),
  explanation: Schema.optional(Schema.String).annotate({
    description: "What you were trying to do and why it is failing",
  }),
  attempted: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Approaches already tried and their results",
  }),
  blocker: Schema.optional(Schema.String).annotate({
    description: "What specifically prevents progress",
  }),
  question: Schema.String.annotate({ description: "A focused question about what to try next" }),
  evidence: Schema.optional(Evidence).annotate({
    description: "Optional supporting detail, especially for web/browser issues",
  }),
})

type Metadata = {
  role: string
  confidence: number
  sessionId: string
}

function renderOutput(input: { role: string; sessionID: SessionID; text: string }) {
  return [
    `<consult role="${input.role}" id="${input.sessionID}">`,
    "<advice>",
    input.text,
    "</advice>",
    "</consult>",
  ].join("\n")
}

function renderPrompt(params: Schema.Schema.Type<typeof Parameters>) {
  const evidence = params.evidence
  const list = (items?: readonly string[]) => (items?.length ? items.map((item) => `- ${item}`).join("\n") : undefined)
  const lines = [
    "An implementor agent is stuck and is escalating to you for guidance. Do not implement changes; diagnose the blocker and recommend concrete next steps.",
    "",
    `<role>${params.role}</role>`,
    `<confidence>${params.confidence}</confidence>`,
    `<subproblem>${params.subproblem}</subproblem>`,
  ]
  if (params.explanation) lines.push("<explanation>", params.explanation, "</explanation>")
  if (list(params.attempted)) lines.push("<attempted>", list(params.attempted)!, "</attempted>")
  if (params.blocker) lines.push("<blocker>", params.blocker, "</blocker>")
  if (evidence) {
    const evidenceLines = [
      evidence.url ? `url: ${evidence.url}` : undefined,
      evidence.viewport ? `viewport: ${evidence.viewport}` : undefined,
      list(evidence.consoleErrors) ? `consoleErrors:\n${list(evidence.consoleErrors)}` : undefined,
      list(evidence.networkFailures) ? `networkFailures:\n${list(evidence.networkFailures)}` : undefined,
      evidence.domSnapshot ? `domSnapshot:\n${evidence.domSnapshot}` : undefined,
      list(evidence.reproduction) ? `reproduction:\n${list(evidence.reproduction)}` : undefined,
      list(evidence.relevantFiles) ? `relevantFiles:\n${list(evidence.relevantFiles)}` : undefined,
    ].filter((line): line is string => line !== undefined)
    if (evidenceLines.length > 0) lines.push("<evidence>", ...evidenceLines, "</evidence>")
  }
  lines.push("<question>", params.question, "</question>")
  return lines.join("\n")
}

const mimeFromPath = (filepath: string) => {
  const ext = path.extname(filepath).toLowerCase()
  switch (ext) {
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".gif":
      return "image/gif"
    case ".webp":
      return "image/webp"
    case ".svg":
      return "image/svg+xml"
    default:
      return "image/png"
  }
}

export const ConsultTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const database = yield* Database.Service
    const modelpick = yield* ModelPick.Service
    const global = yield* Global.Service

    const run = Effect.fn("ConsultTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const cfg = yield* config.get()

      const advisor = yield* agent.get(params.role)
      if (!advisor) {
        const available = (yield* agent.list())
          .filter((item) => item.mode !== "primary" && !item.hidden)
          .map((item) => item.name)
        const hint = available.length ? ` Available advisory agents: ${available.join(", ")}` : ""
        return yield* Effect.fail(new Error(`Unknown escalation role: "${params.role}" is not a valid agent.${hint}`))
      }

      yield* ctx.ask({
        permission: id,
        patterns: [params.role],
        always: ["*"],
        metadata: {
          role: params.role,
          subproblem: params.subproblem,
          confidence: params.confidence,
        },
      })

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      const allows = (permission: string) =>
        advisor.permission.some((rule) => rule.permission === permission && rule.action === "allow")
      const childPermission = [
        ...deriveSubagentSessionPermission({
          parentSessionPermission: parent.permission ?? [],
          subagent: advisor,
        }),
        ...(allows(id) ? [] : [{ permission: id, pattern: "*", action: "deny" as const }]),
        ...(allows("edit") ? [] : [{ permission: "edit", pattern: "*", action: "deny" as const }]),
      ]

      const nextSession = yield* sessions.create({
        parentID: ctx.sessionID,
        title: `Consult ${params.role}: ${params.subproblem}`,
        agent: advisor.name,
        permission: childPermission,
      })

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant
      const parentModel = {
        modelID: ModelV2.ID.make(msg.info.modelID),
        providerID: ProviderV2.ID.make(msg.info.providerID),
      }

      // Prefer the advisory role's pinned model, then a model the user has
      // already chosen and saved for this role, then prompt for one and save
      // the choice.
      const pickModel = (model: { providerID: string; modelID: string }) => ({
        modelID: ModelV2.ID.make(model.modelID),
        providerID: ProviderV2.ID.make(model.providerID),
      })
      let model
      if (advisor.model) model = pickModel({ modelID: advisor.model.modelID, providerID: advisor.model.providerID })
      else {
        const persisted = yield* ModelPickStore.find(global.config, params.role)
        if (persisted) model = pickModel(persisted)
        else {
          const picked = yield* modelpick
            .ask({
              sessionID: ctx.sessionID,
              role: params.role,
              subproblem: params.subproblem,
              tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            })
            .pipe(
              Effect.catchTag("ModelPickRejectedError", () =>
                Effect.fail(
                  new Error(
                    "Advisory model not selected. The model picker was dismissed; set a model on the advisory role or retry the consult.",
                  ),
                ),
              ),
            )
          yield* ModelPickStore.save(global.config, params.role, picked).pipe(Effect.orDie)
          model = pickModel(picked)
        }
      }
      const inherited = model.modelID === parentModel.modelID && model.providerID === parentModel.providerID

      yield* ctx.metadata({
        title: `Consult ${params.role}`,
        metadata: {
          role: params.role,
          confidence: params.confidence,
          sessionId: nextSession.id,
        },
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("ConsultTool requires promptOps in ctx.extra"))

      const { worktree } = yield* InstanceState.context
      const parts: Types.DeepMutable<SessionPrompt.PromptInput["parts"]> = [
        { type: "text", text: renderPrompt(params) },
      ]
      for (const screenshot of params.evidence?.screenshots ?? []) {
        const filepath = path.isAbsolute(screenshot) ? screenshot : path.resolve(worktree, screenshot)
        parts.push({
          type: "file",
          url: pathToFileURL(filepath).href,
          filename: screenshot,
          mime: mimeFromPath(filepath),
        })
      }

      const runConsult = Effect.fn("ConsultTool.runConsult")(function* () {
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: inherited ? variant : undefined,
          agent: advisor.name,
          parts,
        })
        if (result.info.role === "assistant" && result.info.error) {
          const message =
            "message" in result.info.error.data && typeof result.info.error.data.message === "string"
              ? result.info.error.data.message
              : result.info.error.name
          return yield* Effect.fail(new Error(`Consultation failed (${nextSession.id}): ${message}`))
        }
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        if (failed?.type === "tool" && failed.state.status === "error") {
          return yield* Effect.fail(new Error(`Consultation failed (${nextSession.id}): ${failed.state.error}`))
        }
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const advice = yield* runConsult()
      return {
        title: `Consulted ${params.role}`,
        metadata: {
          role: params.role,
          confidence: params.confidence,
          sessionId: nextSession.id,
        },
        output: renderOutput({ role: params.role, sessionID: nextSession.id, text: advice }),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
