# Forced Open Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add owner-only forced-open review workflows and shift-based report endpoints while preserving every existing parking, payment, device, notification, and report flow.

**Architecture:** A shared Luxon shift-window helper defines the strict organization-local `[08:00, next 08:00)` range. A dedicated `forcedOpenAudit` module owns audit reads, fuzzy session search, and transactional review creation; reports reuse the same shift and review aggregation primitives. Cleanup jobs gain narrowly scoped anti-deletion predicates for forced-open retention and saved reviews.

**Tech Stack:** TypeScript, Express, Knex, MySQL, Luxon, Vitest, Supertest

**Spec:** User-provided TZ dated 2026-10-30 in this task.

## Global Constraints

- Work only in the current main checkout; do not create a worktree or branch.
- Do not commit, push, or stash.
- Production code must contain no new comments.
- Only review creation may write business data; every other new endpoint is read-only.
- Existing cash, online, card, LED, Telegram, camera, relay, forced-open, cleanup, and report behavior must remain unchanged except where the TZ explicitly requires cleanup protection.
- Add exactly one forward migration and only one new table.

## Review Focus

- DST and timezone conversion must keep organization-local 08:00 boundaries exact.
- Resolved-session precedence must not accidentally classify a forced-open candidate from an unrelated matched session.
- Missing tariff snapshots must stay `null` in previews and must not be silently persisted as zero.
- Duplicate concurrent review inserts must return 409 without creating duplicate activity logs.
- Daily report middleware semantics must remain identical on both shift report endpoints.

---

### Task 1: Shift Window and Schema

**Files:**
- Create: `src/utils/shiftWindow.ts`
- Create: `migrations/20261030090000_create_forced_open_reviews.ts`
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Test: `tests/unit/shiftWindow.test.ts`
- Test: `tests/unit/env.test.ts`

**Interfaces:**
- Produces: `getOrganizationShiftWindow(date: string, timezone: string): { date: string; from: Date; to: Date }`
- Produces: `env.forcedOpenRetentionDays: number`

- [ ] Write failing unit tests for strict 07:59/08:00 boundaries in two timezones and the retention default/override.
- [ ] Run the focused tests and confirm they fail because the new interfaces do not exist.
- [ ] Implement the helper, environment setting, example value, and forward-only table migration.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Forced-Open Owner API

**Files:**
- Create: `src/modules/forcedOpenAudit/forcedOpenAudit.service.ts`
- Create: `src/modules/forcedOpenAudit/forcedOpenAudit.controller.ts`
- Create: `src/modules/forcedOpenAudit/forcedOpenAudit.routes.ts`
- Modify: `src/app.ts`
- Test: `tests/integration/forcedOpenAudit.test.ts`

**Interfaces:**
- Consumes: `getOrganizationShiftWindow`, `canonicalizePlate`, `plateDistance`, `similarityPercent`, `calculateTariffSnapshotAmount`
- Produces: GET audit list, POST search, POST reviews, GET reviews at `/api/forced-open-audit`
- Produces: `getForcedOpenReviewSummary(orgId, operatorId, from, to, executor?)`

- [ ] Write failing integration tests for list classification, tariff calculation, fuzzy search, org/time scoping, review persistence, duplicate/concurrent writes, totals, and role denial.
- [ ] Run the focused integration tests and confirm route-not-found or missing-table failures.
- [ ] Implement owner-only routes, validation, service reads, and transactional review creation with one activity log.
- [ ] Run the focused tests and confirm they pass.

### Task 3: Cleanup Retention and Saved-Review Protection

**Files:**
- Modify: `src/jobs/webhookEventsCleanupJob.ts`
- Modify: `src/modules/maintenance/staleSessionsCleanup.service.ts`
- Test: `tests/integration/webhookEventsCleanup.test.ts`
- Test: `tests/unit/staleSessionsCleanupJob.test.ts`

**Interfaces:**
- Consumes: `env.forcedOpenRetentionDays`
- Protects: webhook events linked to recent forced-open candidates or any saved forced-open review.

- [ ] Extend cleanup tests first for four-day forced-open retention, unchanged 24-hour cleanup, and both saved-review protection paths.
- [ ] Run the focused tests and confirm the new cases fail.
- [ ] Add the two scoped `NOT EXISTS` protections without changing other deletion predicates.
- [ ] Run the focused tests and confirm they pass.

### Task 4: Shift Reports

**Files:**
- Modify: `src/modules/reports/reports.service.ts`
- Modify: `src/modules/reports/reports.controller.ts`
- Modify: `src/modules/reports/reports.routes.ts`
- Test: `tests/integration/reports.test.ts`

**Interfaces:**
- Consumes: `getOrganizationShiftWindow`, `getForcedOpenReviewSummary`
- Produces: `getShiftOperatorReport(...)`, `getShiftReport(...)`
- Produces: GET `/api/reports/shift-operator` and GET `/api/reports/shift`

- [ ] Write failing integration tests for operator activity ranking, role filtering, empty activity, payment-method totals, completed exits, non-filtering by operator, and optional saved-review totals.
- [ ] Run the focused tests and confirm the new routes fail.
- [ ] Implement the two services/controllers/routes using the exact daily-report access middleware.
- [ ] Run the focused tests and confirm they pass.

### Task 5: Verification and Regression

**Files:**
- Verify all modified and added files.

**Interfaces:**
- Produces: evidence for all requested test, typecheck, build, lint, and diff-stat report items.

- [ ] Run the new focused test files together.
- [ ] Run `npm test` and record every failure by name.
- [ ] Run `npm run typecheck`, `npm run typecheck:tests`, `npm run build`, and `npm run lint`.
- [ ] Inspect `git diff --check`, `git diff --stat`, and the final patch for scope violations and comments.

### Task 6: Matched Session Audit Fallback Amendment

**Files:**
- Modify: `src/modules/forcedOpenAudit/forcedOpenAudit.service.ts`
- Modify: `tests/integration/forcedOpenAudit.test.ts`

**Interfaces:**
- Preserves: `candidateSessionId` priority `resolved_session_id`, then an organization-scoped existing `matched_session_id`
- Preserves: all forced-open audit response shapes and review validation contracts
- Produces: matched-only existing sessions as `session_found`, while missing or cross-organization matches remain `not_found`

- [ ] Replace the matched-only regression expectation and add explicit tests for matched amount/forced_closed, missing match, cross-organization match, automatic review save, duplicate save, and search 409.
- [ ] Run `npm test -- tests/integration/forcedOpenAudit.test.ts` and confirm failures are caused by resolved-only classification.
- [ ] Update the candidate session selection and organization-scoped join with resolved-session precedence.
- [ ] Run the focused test and confirm all amendment and existing audit cases pass.
- [ ] Run the full regression suite, TypeScript checks, build, lint, and final diff inspection.

### Task 7: One Review per Session Amendment

**Files:**
- Modify: `src/modules/forcedOpenAudit/forcedOpenAudit.service.ts`
- Modify: `tests/integration/forcedOpenAudit.test.ts`

**Interfaces:**
- Preserves: GET `/api/forced-open-audit` response shape and global `forced_at` ascending order
- Preserves: POST `/api/forced-open-audit/reviews` response shape and candidate-level UNIQUE behavior
- Produces: one visible `session_found` candidate per session and one saved review per org/session under concurrent writes

- [ ] Add failing integration tests for two/three candidates per session, saved/confidence/time priority, hidden externally reviewed sessions, unchanged distinct/not-found rows, sequential and parallel duplicate saves, and org isolation.
- [ ] Run `npm test -- tests/integration/forcedOpenAudit.test.ts` and confirm failures are caused by missing session deduplication and session-level save protection.
- [ ] Deduplicate session-found rows after org-scoped review lookup while preserving the original forced-at order.
- [ ] Lock the selected session row with `FOR UPDATE`, then check for an existing org/session review in the same `READ COMMITTED` transaction and return 409 when found.
- [ ] Run focused tests, the full regression suite, TypeScript checks, build, lint, and final diff inspection.
