import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(5000),
  CLIENT_URL: z.string().url().default("http://localhost:5173"),
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/aevora"),
  // Better Auth signs and encrypts with this; 32+ random characters
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  // the URL the BROWSER uses to reach /api/auth (in dev: the Vite origin, because Vite proxies /api)
  BETTER_AUTH_URL: z.string().url().default("http://localhost:5173"),
  // Google sign-in turns on when both are set
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // All NEW production media is stored privately on ImageKit. Local mode is for development.
  STORAGE_PROVIDER: z.enum(['local', 'imagekit']).default(process.env.NODE_ENV === 'production' ? 'imagekit' : 'local'),
  IMAGEKIT_PRIVATE_KEY: z.string().optional(),
  IMAGEKIT_PUBLIC_KEY: z.string().optional(),
  IMAGEKIT_URL_ENDPOINT: z.string().url().optional(),
  IMAGEKIT_FOLDER_PREFIX: z.string().default('/aevora'),
  // Optional legacy R2 credentials ONLY for reading/migrating existing R2 objects.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_ENDPOINT: z.string().url().optional(),
  MAX_USER_STORAGE_MB: z.coerce.number().positive().default(2048),
  MAX_MEDIA_DURATION_SEC: z.coerce.number().positive().default(600),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

if (parsed.success && parsed.data.STORAGE_PROVIDER === 'imagekit') {
  const required = ['IMAGEKIT_PRIVATE_KEY', 'IMAGEKIT_URL_ENDPOINT'];
  const missing = required.filter((name) => !parsed.data[name]);
  if (missing.length) {
    console.error(`ImageKit storage is enabled but missing: ${missing.join(', ')}. Configure server/.env (never expose the private key in Vite).`);
    process.exit(1);
  }
  if (!parsed.data.IMAGEKIT_URL_ENDPOINT.startsWith('https://')) {
    console.error('IMAGEKIT_URL_ENDPOINT must use HTTPS.');
    process.exit(1);
  }
}
if (parsed.success && parsed.data.NODE_ENV === 'production' && parsed.data.STORAGE_PROVIDER !== 'imagekit') {
  console.error('Production media storage must use STORAGE_PROVIDER=imagekit.');
  process.exit(1);
}
export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
