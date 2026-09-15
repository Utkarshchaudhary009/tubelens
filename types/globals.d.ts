// Clerk session-token claim typing (Part B Phase 03).
//
// Source of truth: plans/PLANS_AND_USAGE.md §3. The Clerk Dashboard
// session-token template projects the authoritative tier into every token:
//   {"metadata":"{{user.public_metadata}}","tubelens":{"tier":"{{user.public_metadata.tier}}"}}
// Keep total custom claims under 1.2KB (browser cookie size limits).
//
// Declaring `CustomJwtSessionClaims` here merges with Clerk's SDK type, so
// `auth().sessionClaims` is typed on hot paths without a Backend API call.
// Fields stay `unknown`: the server must pass them through `normalizeTier`
// (missing/invalid → `free`, never self-escalating).
export {};

declare global {
  interface CustomJwtSessionClaims {
    tubelens?: {
      tier?: unknown;
    };
    metadata?: {
      role?: unknown;
    };
  }
}
