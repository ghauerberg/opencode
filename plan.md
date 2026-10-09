# Plan: Advisor pattern follow-ups (`advisor-subagent`)

## Objective

The advisor pattern is implemented on `advisor-subagent` (transient read-only child
session, transcript prompt, advice injected back as a normal user message). The
"advisor never runs with the ball" guarantee holds. This plan closes the known
gaps so the feature is coherent, configurable, and does not regress shared code.

## Status

| # | Item | Status |
|---|------|--------|
| 1 | Honor `advisor.automatic.enabled` | done (081a1c87b) |
| 2 | Implement `failMode: "pause"` | done (081a1c87b) |
| 3 | Fix `Session.setArchived` regression | done (081a1c87b) |
| 4 | Fix stale advisor prompt wording | done (081a1c87b) |
| 5 | Tests for the above | done (081a1c87b) |
| 6 | Wire model picker into app/desktop | done |
| 7 | Reconcile `consult` vs `advisor_review` | done (documented coexistence) |
| 8 | Advisor full pre-compaction history | done (config option) |
| 9 | Per-session advisor state survives restart | done |

## Changes (items 1-5)

- `packages/opencode/src/advisor/schema.ts` — add `AutoOutcome = "none" | "reviewed" | "halt"`.
- `packages/opencode/src/advisor/index.ts`
  - `maybeAutoReview` now returns `AutoOutcome` and reads `automatic.enabled`.
  - `failMode: "pause"` returns `"halt"` when an automatic review fails (instead of
    being silently ignored).
  - Archive the temporary child with an explicit `time: Date.now()`.
- `packages/opencode/src/session/prompt.ts` — loop handles `"halt"` (publish an
  error, break) and `"reviewed"` (continue).
- `packages/opencode/src/session/session.ts` — restore `setArchived` to the shared
  contract (`input.time`, no implicit `Date.now()`); the HTTP handler already
  guards on `time !== undefined`, so the default only affected internal callers.
- `packages/opencode/src/agent/prompt/advisor.txt` — say "transcript", not "fork".
- Tests: 2 new advisor cases, 1 session case, assertions updated to the new union.

## Verification

- `cd packages/opencode && bun test test/advisor/advisor.test.ts test/session/session.test.ts test/session/tools.test.ts`
- `cd packages/opencode && bun test test/session/prompt.test.ts`
- `cd packages/opencode && bun test test/tool/consult.test.ts test/server/global-session-list.test.ts`
- Do **not** run `bun typecheck` / `tsgo` — it crashes this sandbox (OOM/restart).

## Item 6 — model picker in app/desktop

The `modelpick.asked` flow was handled only in `tui/src/app.tsx`. The app now
handles it end to end, which also covers desktop because the desktop renderer
mounts the shared app UI:

- `packages/app/src/context/global-sync/{types,session-cache,event-reducer,child-store,bootstrap}.ts`
  and `packages/app/src/context/server-session.ts` — new `modelpick` slice with
  `asked`/`replied`/`rejected` reducer cases and a bootstrap list fetch, mirroring
  `question`.
- `packages/app/src/pages/session/composer/session-request-tree.ts` and
  `session-composer-state.ts` — `sessionModelPickRequest`, `replyModelPick`,
  `rejectModelPick`; the composer is blocked while a pick is pending.
- `packages/app/src/pages/session/composer/session-modelpick-dock.tsx` — new dock
  using the shared `DockPrompt` (`kind: "modelpick"`), `List`, and model visibility
  filtering.
- `packages/session-ui/src/components/dock-prompt.tsx` + `message-part.css` — the
  `modelpick` dock kind and its styles.
- `packages/app/src/i18n/*.ts` — `session.modelpick.{title,role,subproblem}` added
  to English and all 61 other locales.

## Item 7 — `consult` vs `advisor_review`

The two mechanisms are kept, deliberately, because neither is a superset of the
other:

- `advisor_review` (and `/advice`) runs a **whole-session strategic review** from the
  visible transcript.
- `consult` (and `/advisormodel`) escalates **one subproblem to a named advisory
  role** with structured fields and returns `<consult>` advice.

They share the read-only child-session contract and the `ModelPickStore` role→model
map. Rather than force a merge (which would lose the structured per-role escalation
or the session review and churn ~11 tests, a JSON-schema snapshot, i18n keys, and
the generated SDK), each tool description now states its niche and points at the
other, and `consult.ts` documents the intentional coexistence. Recursion guards are
verified: the advisor child denies everything; the consult child denies `edit`,
`consult`, and `task`.

## Item 8 — full pre-compaction history

`advisor.history` (`"compacted"` default, `"full"` opt-in) selects the transcript
source. `"compacted"` matches the primary agent's visible view (everything since the
last compaction, with the summary standing in for earlier work). `"full"` uses
`MessageV2.stream` for the entire uncompacted transcript, which can exceed the
model's context window (already handled by the existing `ContextOverflowError`
branch).

## Item 9 — durable advisor state

`Advisor.Persisted` (steps, cycle, history, lastReview — never the transient
`advisorRunning` flag) is written to session metadata under `advisorState` and read
back on the next process. Malformed metadata is ignored rather than failing the
session, and metadata write failures are best-effort.

## Verification

- `cd packages/opencode && bun test test/advisor/advisor.test.ts test/tool/consult.test.ts test/tool/parameters.test.ts test/tool/task.test.ts`
- `cd packages/opencode && bun test test/session/prompt.test.ts test/session/session.test.ts test/session/tools.test.ts`
- `cd packages/app && bun test --conditions=solid --preload ./happydom.ts src/context/global-sync/ src/pages/session/composer/ src/i18n/`
- `cd packages/session-ui && bun test && bun run typecheck`

Do **not** run `bun typecheck` / `tsgo` from `packages/opencode` — it crashes this
sandbox (OOM/restart).
