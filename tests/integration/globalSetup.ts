import path from "path";
import { execSync } from "child_process";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

const projectRoot = path.resolve(__dirname, "../..");

export default async function setup() {
  dotenv.config({ path: path.join(projectRoot, ".env.test"), override: true });
  process.env.ENCRYPTION_KEY ||=
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } = process.env;

  if (DB_NAME !== "stoyanka_test") {
    throw new Error(
      `Xavfsizlik to'xtatuvi: DB_NAME="${DB_NAME}", kutilgan "stoyanka_test". .env.test faylini tekshiring.`
    );
  }

  const connection = await mysql.createConnection({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
  });
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
  await connection.end();

  execSync("npx knex --knexfile knexfile.ts migrate:latest", {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
}
