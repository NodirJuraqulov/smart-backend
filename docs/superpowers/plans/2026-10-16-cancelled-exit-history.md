# Cancelled Exit History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scoped, paginated cancelled-exit history endpoint and retain its webhook event images for 30 days.

**Architecture:** A focused history service owns organization-timezone filtering and response serialization. The existing webhook cleanup query gains only an `exit_cancelled` retention exclusion, while stale-session cleanup remains unchanged.

**Tech Stack:** TypeScript, Express, Knex, MySQL, Luxon, Vitest, Supertest

**Spec:** Approved conversation TZ dated 2026-10-16

## Global Constraints

- Work only on `main`; do not create a worktree or branch.
- Do not commit, push, or stash.
- Write clean code without comments.
- Preserve every existing flow outside the approved endpoint and retention behavior.
- Add no migration.

## Review Focus

- Reject invalid dates and ranges longer than 31 inclusive calendar days.
- Prevent cross-organization history access for non-super-admin users.
- Preserve nullable plates and resolver fallback behavior.
- Protect only recent `exit_cancelled` webhook events from the 05:00 cleanup.
- Confirm stale-session cleanup cannot delete an unrelated cancelled candidate or webhook event.

---

### Task 1: Cancelled Exit History Endpoint

**Files:**
- Create: `tests/integration/cancelledExitHistory.test.ts`
- Create: `src/modules/exitCandidates/cancelledExitHistory.service.ts`
- Modify: `src/modules/exitCandidates/exitCandidates.controller.ts`
- Modify: `src/modules/exitCandidates/exitCandidates.routes.ts`

**Interfaces:**
- Consumes: existing sessions permission middleware, org scope helper, organization timezone.
- Produces: `GET /api/exit-candidates/cancelled` with `history` and `pagination`.

- [ ] Write endpoint integration tests for filtering, org scope, 31-day validation, timezone, nullable plate, pagination, and permission.
- [ ] Run the focused test and verify it fails because the route is absent.
- [ ] Implement the minimal service, controller, and route.
- [ ] Run the focused test and verify it passes.

### Task 2: Cancelled Exit Retention

**Files:**
- Create: `tests/integration/webhookEventsCleanup.test.ts`
- Modify: `src/jobs/webhookEventsCleanupJob.ts`
- Modify: `src/config/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `tb_exit_candidates.webhook_event_id`, `resolution_type`, and `resolved_at`.
- Produces: `env.cancelledExitRetentionDays` and cleanup exclusion for recent cancelled exits.

- [ ] Write cleanup integration tests for protected cancelled events, expired cancelled events, and unchanged ordinary cleanup.
- [ ] Run the focused test and verify current cleanup deletes the protected record.
- [ ] Add the default-30 environment setting and the narrow cleanup exclusion.
- [ ] Run the focused test and verify it passes.

### Task 3: Stale Cleanup Regression

**Files:**
- Modify: `tests/integration/staleSessionsCleanup.test.ts`

**Interfaces:**
- Consumes: existing stale-session cleanup behavior.
- Produces: regression proof that unrelated cancelled candidates and webhook events remain.

- [ ] Write the stale-session cleanup regression test.
- [ ] Run it against unchanged production behavior and verify it passes.
- [ ] Run endpoint, cleanup, and stale-session focused suites together.

### Task 4: Verification

**Files:**
- Verify all changed production and test files.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: final validation evidence and requested report.

- [ ] Run `npm run typecheck` and `npm run typecheck:tests`.
- [ ] Run `npm run build` and `npm run lint`.
- [ ] Run the complete `npm test` suite.
- [ ] Inspect `git diff --check`, `git diff --stat`, and final `git status --short`.
