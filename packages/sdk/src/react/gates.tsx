"use client";

/**
 * Auth gates — Clerk-style conditional rendering based on auth state.
 *
 * <Authenticated>   — renders children only when authenticated
 * <Unauthenticated> — renders children only when not authenticated
 * <AuthLoading>     — renders children only while auth is resolving
 */

import React from "react";
import { useSnapshot } from "valtio";
import { useParcae } from "./context";
import type { AuthStatus } from "../auth-gate";

function useAuthStatus(): AuthStatus {
  const client = useParcae();
  const transport = client.transport as any;
  const authState = transport?.auth?.state;
  if (!authState) return "pending";
  const snap = useSnapshot(authState);
  return (snap as any).status ?? "pending";
}

interface GateProps {
  children: React.ReactNode;
  /** Optional fallback to render when the gate condition is not met. */
  fallback?: React.ReactNode;
}

/**
 * Renders children only when the user is authenticated.
 *
 * ```tsx
 * <Authenticated fallback={<LoginPage />}>
 *   <Dashboard />
 * </Authenticated>
 * ```
 */
export function Authenticated({ children, fallback = null }: GateProps) {
  const status = useAuthStatus();
  if (status === "authenticated") return <>{children}</>;
  return <>{fallback}</>;
}

/**
 * Renders children only when the user is NOT authenticated.
 *
 * ```tsx
 * <Unauthenticated>
 *   <LoginForm />
 * </Unauthenticated>
 * ```
 */
export function Unauthenticated({ children, fallback = null }: GateProps) {
  const status = useAuthStatus();
  if (status === "unauthenticated") return <>{children}</>;
  return <>{fallback}</>;
}

/**
 * Renders children only while auth is still loading.
 *
 * ```tsx
 * <AuthLoading>
 *   <Spinner />
 * </AuthLoading>
 * ```
 */
export function AuthLoading({ children, fallback = null }: GateProps) {
  const status = useAuthStatus();
  if (status === "pending") return <>{children}</>;
  return <>{fallback}</>;
}
