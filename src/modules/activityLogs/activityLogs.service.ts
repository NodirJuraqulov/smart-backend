import type { Knex } from "knex";
import { db } from "@/config/db";

interface ActivityLogRow {
  id: number;
  action: string;
  target_type: string | null;
  target_id: number | null;
  details: string | object | null;
  created_at: Date;
  actor_name: string | null;
}

interface ListActivityLogsFilters {
  action?: string;
  target_type?: string;
  date?: string;
  page: number;
  limit: number;
}

function activityLogsBaseQuery(executor: Knex) {
  return executor<ActivityLogRow>("tb_activity_logs")
    .leftJoin("tb_users", "tb_activity_logs.actor_id", "tb_users.id")
    .select(
      "tb_activity_logs.id",
      "tb_activity_logs.action",
      "tb_activity_logs.target_type",
      "tb_activity_logs.target_id",
      "tb_activity_logs.details",
      "tb_activity_logs.created_at",
      "tb_users.name as actor_name"
    );
}

function applyActivityLogFilters<T extends Knex.QueryBuilder>(
  query: T,
  filters: ListActivityLogsFilters
): T {
  if (filters.action) {
    query.andWhere("tb_activity_logs.action", filters.action);
  }
  if (filters.target_type) {
    query.andWhere("tb_activity_logs.target_type", filters.target_type);
  }
  if (filters.date) {
    const dayStart = new Date(`${filters.date}T00:00:00`);
    const dayEnd = new Date(`${filters.date}T23:59:59.999`);
    query.andWhereBetween("tb_activity_logs.created_at", [dayStart, dayEnd]);
  }
  return query;
}

export async function listActivityLogs(filters: ListActivityLogsFilters) {
  const [{ count }] = await applyActivityLogFilters(db("tb_activity_logs"), filters).count<
    { count: string }[]
  >("id as count");
  const total = Number(count);

  const rows = await applyActivityLogFilters(activityLogsBaseQuery(db), filters)
    .orderBy("tb_activity_logs.created_at", "desc")
    .limit(filters.limit)
    .offset((filters.page - 1) * filters.limit);

  const logs = rows.map((row) => ({
    ...row,
    details: typeof row.details === "string" ? JSON.parse(row.details) : row.details,
  }));

  return {
    logs,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      total_pages: Math.ceil(total / filters.limit) || 1,
    },
  };
}
