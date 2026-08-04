import 'dotenv/config';

console.log("Current Directory:", process.cwd());
console.log("MONGODB_URI:", process.env.MONGODB_URI);

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 5000),

  mongoUri: required('MONGODB_URI'),

  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',

  bcryptSaltRounds: Number(process.env.BCRYPT_SALT_ROUNDS ?? 12),
  // No wildcard fallback: combined with `credentials: true` in app.ts, a default of "*" would
  // reflect any origin for credentialed requests. Must be set explicitly (see .env.example).
  corsOrigin: required('CORS_ORIGIN').split(',').map((origin) => origin.trim()),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 900000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 100),

  seedSuperAdmin: {
    name: process.env.SEED_SUPER_ADMIN_NAME ?? 'Super Admin',
    email: process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@gmail.com',
    password: process.env.SEED_SUPER_ADMIN_PASSWORD ?? '1',
  },
  // Optional — if not set, AI verification falls back to Rule Engine only.
  geminiApiKey: process.env.GEMINI_API_KEY,
} as const;

// Print a clear startup notice so the operator knows the AI mode at boot time.
if (!process.env.GEMINI_API_KEY) {
  console.warn(
    '[AI] GEMINI_API_KEY is not set. ' +
    'AI verification will run in Rule Engine only mode. ' +
    'Set GEMINI_API_KEY in .env to enable full Gemini analysis.',
  );
} else {
  console.info('[AI] Gemini AI is configured. Model: gemini-2.0-flash. Full AI verification enabled.');
}

export const isProduction = env.nodeEnv === 'production';
