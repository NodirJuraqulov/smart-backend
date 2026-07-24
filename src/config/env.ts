import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT) || 5000,

  db: {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    name: required("DB_NAME"),
    user: required("DB_USER"),
    password: process.env.DB_PASSWORD || "",
    poolMin: Number(process.env.DB_POOL_MIN) || 2,
    poolMax: Number(process.env.DB_POOL_MAX) || 20,
  },

  jwt: {
    secret: required("JWT_SECRET"),
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
  },

  encryptionKey: required("ENCRYPTION_KEY"),

  refreshToken: {
    expiresDays: Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS) || 30,
  },

  pythonOcrUrl: process.env.PYTHON_OCR_URL || "http://localhost:8000",
  internalApiKey: process.env.INTERNAL_API_KEY || "",
  corsOrigin: process.env.CORS_ORIGIN || "*",

  uploadsMaxSizeMB: Number(process.env.UPLOADS_MAX_SIZE_MB) || 2000,

  platformDefaultTimezone: process.env.PLATFORM_DEFAULT_TIMEZONE || "Asia/Tashkent",
};

const WEAK_DB_PASSWORDS = ["password", "123456", "12345678", "admin", "root", "qwerty", "changeme"];

function validateProductionSafety(): void {
  if (env.nodeEnv !== "production") return;

  const errors: string[] = [];

  if (env.jwt.secret === "dev_secret_change_me" || env.jwt.secret.length < 32) {
    errors.push("JWT_SECRET dev qiymatida qolgan yoki juda qisqa (kamida 32 belgi kerak)");
  }

  if (env.encryptionKey.length !== 64) {
    errors.push("ENCRYPTION_KEY noto'g'ri uzunlikda (32 bayt = 64 hex belgi kerak)");
  }

  if (env.corsOrigin === "*" || env.corsOrigin.includes("localhost")) {
    errors.push("CORS_ORIGIN localhost'ga ishora qilmoqda yoki belgilanmagan — production domenini ko'rsating");
  }

  const dbPassword = env.db.password.toLowerCase();
  if (!dbPassword || dbPassword.length < 8 || WEAK_DB_PASSWORDS.includes(dbPassword)) {
    errors.push("DB_PASSWORD bo'sh, juda qisqa yoki juda oddiy — kuchli, tasodifiy parol o'rnating");
  }

  if (errors.length > 0) {
    console.error("XAVFSIZLIK XATOSI — production rejimida ishga tushirib bo'lmaydi:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
}

validateProductionSafety();
