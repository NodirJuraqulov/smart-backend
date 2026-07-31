import type { Knex } from "knex";

export const INSIDE_SESSION_STATUSES = ["active", "awaiting_payment"] as const;
export const COMPLETED_SESSION_STATUS = "completed" as const;

export function applyInsideSessionsFilter<TRecord extends object, TResult>(
  query: Knex.QueryBuilder<TRecord, TResult>
): Knex.QueryBuilder<TRecord, TResult> {
  return query.whereIn("status", [...INSIDE_SESSION_STATUSES]);
}

export function applyCompletedExitFilter<TRecord extends object, TResult>(
  query: Knex.QueryBuilder<TRecord, TResult>
): Knex.QueryBuilder<TRecord, TResult> {
  return query.where("status", COMPLETED_SESSION_STATUS).whereNotNull("exited_at");
}
