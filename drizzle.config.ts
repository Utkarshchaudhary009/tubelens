import { defineConfig } from "drizzle-kit";

// Migrations run against the DIRECT (non-pooled) connection string.
// Never commit real URLs — both come from env / Vercel envs only.
const directUrl = process.env.DATABASE_DIRECT_URL ?? "";

// `drizzle-kit generate` only diffs local schema files and never connects
// to Postgres, so it must work in credential-free envs. Every other
// subcommand (migrate, push, studio, check, up, down, pull, …) needs a
// live connection — fail fast with a clear message instead of a cryptic
// empty-url driver error.
const subcommand = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const OFFLINE_SUBCOMMANDS: Set<string | undefined> = new Set([
  "generate",
  undefined, // bare `drizzle-kit` prints help
]);
if (!directUrl && !OFFLINE_SUBCOMMANDS.has(subcommand)) {
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
