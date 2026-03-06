"use client";

import React from "react";
import { useAuthStatus } from "./useAuth";

interface GateProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function Authenticated({ children, fallback = null }: GateProps) {
  const { status } = useAuthStatus();
  return status === "authenticated" ? <>{children}</> : <>{fallback}</>;
}

export function Unauthenticated({ children, fallback = null }: GateProps) {
  const { status } = useAuthStatus();
  return status === "unauthenticated" ? <>{children}</> : <>{fallback}</>;
}

export function AuthLoading({ children, fallback = null }: GateProps) {
  const { status } = useAuthStatus();
  return status === "pending" ? <>{children}</> : <>{fallback}</>;
}
