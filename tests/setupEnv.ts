import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env.test"), override: true });

if (process.env.DB_NAME === "stoyanka_db") {
  throw new Error(
    "Xavfsizlik to'xtatuvi: testlar production bazasiga (stoyanka_db) ulanishga urinmoqda. .env.test faylini tekshiring."
  );
}
