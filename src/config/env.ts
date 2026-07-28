import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolvePublicBaseUrl(): string {
  const raw = process.env.PUBLIC_BASE_URL;
  if (!raw) {
    return `http://localhost:${Number(process.env.PORT) || 5000}`;
  }
  return stripTrailingSlashes(raw);
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

  refreshToken: {
    expiresDays: Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS) || 30,
  },

  pythonOcrUrl: process.env.PYTHON_OCR_URL || "http://localhost:8000",
  internalApiKey: process.env.INTERNAL_API_KEY || "",
  corsOrigin: process.env.CORS_ORIGIN || "*",

  uploadsMaxSizeMB: Number(process.env.UPLOADS_MAX_SIZE_MB) || 2000,

  platformDefaultTimezone: process.env.PLATFORM_DEFAULT_TIMEZONE || "Asia/Tashkent",

  publicBaseUrl: resolvePublicBaseUrl(),

  payments: {
    paymeEnabled: process.env.PAYME_ENABLED === "true",
    clickEnabled: process.env.CLICK_ENABLED === "true",
  },
};

const WEAK_DB_PASSWORDS = ["password", "123456", "12345678", "admin", "root", "qwerty", "changeme"];

export interface ProductionSafetyConfig {
  jwtSecret: string;
  corsOrigin: string;
  dbPassword: string;
  publicBaseUrl: string | undefined;
}

export function collectProductionSafetyErrors(config: ProductionSafetyConfig): string[] {
  const errors: string[] = [];

  if (config.jwtSecret === "dev_secret_change_me" || config.jwtSecret.length < 32) {
    errors.push("JWT_SECRET dev qiymatida qolgan yoki juda qisqa (kamida 32 belgi kerak)");
  }

  if (config.corsOrigin === "*" || config.corsOrigin.includes("localhost")) {
    errors.push("CORS_ORIGIN localhost'ga ishora qilmoqda yoki belgilanmagan — production domenini ko'rsating");
  }

  const dbPassword = config.dbPassword.toLowerCase();
  if (!dbPassword || dbPassword.length < 8 || WEAK_DB_PASSWORDS.includes(dbPassword)) {
    errors.push("DB_PASSWORD bo'sh, juda qisqa yoki juda oddiy — kuchli, tasodifiy parol o'rnating");
  }

  if (!config.publicBaseUrl) {
    errors.push(
      "PUBLIC_BASE_URL belgilanmagan — webhook URL generatsiyasi uchun majburiy (masalan http://195.158.9.168:84)"
    );
  } else {
    try {
      new URL(config.publicBaseUrl);
    } catch {
      errors.push(`PUBLIC_BASE_URL noto'g'ri URL formatida: "${config.publicBaseUrl}"`);
    }
  }

  return errors;
}

function validateProductionSafety(): void {
  if (env.nodeEnv !== "production") return;

  const errors = collectProductionSafetyErrors({
    jwtSecret: env.jwt.secret,
    corsOrigin: env.corsOrigin,
    dbPassword: env.db.password,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
  });

  if (errors.length > 0) {
    console.error("XAVFSIZLIK XATOSI — production rejimida ishga tushirib bo'lmaydi:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
}

validateProductionSafety();
