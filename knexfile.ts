import type { Knex } from "knex";
import dotenv from "dotenv";
import path from "path";

dotenv.config({
  path: path.resolve(__dirname, process.env.NODE_ENV === "test" ? ".env.test" : ".env"),
  override: true,
});

const baseConfig: Knex.Config = {
  client: "mysql2",
  connection: {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  },
  migrations: {
    directory: "./migrations",
    extension: "ts",
  },
  seeds: {
    directory: "./seeds",
    extension: "ts",
  },
};

const config: { [key: string]: Knex.Config } = {
  development: baseConfig,
  test: baseConfig,
  production: {
    ...baseConfig,
    pool: {
      min: Number(process.env.DB_POOL_MIN) || 2,
      max: Number(process.env.DB_POOL_MAX) || 20,
    },
  },
};

export default config;
