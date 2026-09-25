export * as ConfigAdvisorV1 from "./advisor"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the advisor. Defaults to true when the 'advisor' agent exists.",
  }),
  agent: Schema.optional(Schema.String).annotate({
    description: "Name of the advisory subagent to run. Defaults to 'advisor'.",
  }),
  automatic: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description: "Automatically trigger a review every N counted steps. Defaults to true.",
      }),
      every: Schema.optional(PositiveInt).annotate({
        description: "Number of counted tool executions between automatic reviews. Defaults to 50.",
      }),
    }),
  ).annotate({ description: "Automatic review trigger settings" }),
  stepTools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Tool ids that count as a meaningful step toward the automatic review allowance.",
  }),
  failMode: Schema.optional(Schema.Literals(["continue", "pause"])).annotate({
    description: "What to do when a review fails. 'continue' keeps the worker going (default), 'pause' stops it.",
  }),
}).annotate({ identifier: "AdvisorConfig" })

export type Info = Schema.Schema.Type<typeof Info>