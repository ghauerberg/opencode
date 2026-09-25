import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./advisor.txt"
import { Advisor } from "@/advisor"
import type { TaskPromptOps } from "./task"

const id = "advisor_review"

export const Parameters = Schema.Struct({
  reason: Schema.optional(Schema.String).annotate({
    description: "Optional specific concern or question for the advisor to focus on",
  }),
})

type Metadata = {
  trigger: "model"
  sessionId: string
  cycle: number
}

export const AdvisorTool = Tool.define(
  id,
  Effect.gen(function* () {
    const advisor = yield* Advisor.Service

    const run = Effect.fn("AdvisorTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      yield* ctx.ask({
        permission: id,
        patterns: ["*"],
        always: ["*"],
        metadata: {},
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("AdvisorTool requires promptOps in ctx.extra"))

      const review = yield* advisor.runAdvisorReview({
        sessionID: ctx.sessionID,
        trigger: "model",
        reason: params.reason,
        promptOps: ops,
      })

      yield* ctx.metadata({
        title: "Advisor review",
        metadata: {
          trigger: "model",
          sessionId: review.sessionID,
          cycle: review.cycle,
        },
      })

      return {
        title: "Advisor review",
        metadata: {
          trigger: "model",
          sessionId: review.sessionID,
          cycle: review.cycle,
        },
        output: Advisor.renderAdvice({ trigger: "model", cycle: review.cycle, review }),
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
