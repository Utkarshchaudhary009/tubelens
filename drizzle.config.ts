import { defineConfig } from "drizzle-kit";

// Migrations run against the DIRECT (non-pooled) connection string.
// Never commit real URLs — both come from env / Vercel envs only.
const directUrl = process.env.DATABASE_DIRECT_URL;
if (!directUrl) {
  throw new Error(
    "DATABASE_DIRECT_URL is required for migrations: set it to the Neon direct (non-pooled) connection string before running drizzle-kit (see .env.example).",
  );
}

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: directUrl,
  },
});
