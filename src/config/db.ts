import knex from "knex";
import { env } from "./env";

export const db = knex({
  client: "mysql2",
  connection: {
    host: env.db.host,
    port: env.db.port,
    database: env.db.name,
    user: env.db.user,
    password: env.db.password,
    dateStrings: ["DATE"] as unknown as boolean,
  },
  pool: { min: env.db.poolMin, max: env.db.poolMax },
});
