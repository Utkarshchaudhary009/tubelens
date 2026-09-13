// Phase 01 platform boundary: authentication provider seam.
//
// `AuthProvider` is the stable interface behind which all identity logic
// lives. Phase 01 ships only the anonymous default (no Clerk SDK — that
// lands here in Phase 02). Routes must depend on this interface, never on
// provider-specific imports.

export type AuthPrincipalType = "anonymous" | "user" | "api_key";

export interface AuthContext {
  type: AuthPrincipalType;
  /** True for the anonymous default; false once a real principal exists. */
  authenticated: boolean;
  /** Clerk user id once Phase 02 lands; absent for anonymous. */
  userId?: string;
  /** Clerk key reference once Phase 05 lands; never a plaintext secret. */
  keyId?: string;
  /** Owning project/environment label once projects exist (Phase 07+). */
  projectId?: string;
}

export interface AuthProvider {
  /** Resolve the caller principal for this request. Must never throw for
   * anonymous callers — return the anonymous context instead. */
  resolve(req: Request): Promise<AuthContext> | AuthContext;
}

export const anonymousAuthContext: AuthContext = {
  type: "anonymous",
  authenticated: false,
};

/** Phase 01 default: every request is anonymous. */
export const anonymousAuthProvider: AuthProvider = {
  resolve(): AuthContext {
    return { ...anonymousAuthContext };
  },
};

let current: AuthProvider = anonymousAuthProvider;

/** Swap the active provider (used by later phases and by tests). */
export function setAuthProvider(provider: AuthProvider): void {
  current = provider;
}

export function getAuthProvider(): AuthProvider {
  return current;
}

/** Reset to the Phase 01 anonymous default (primarily for tests). */
export function resetAuthProvider(): void {
  current = anonymousAuthProvider;
}
