"use client";

import React from "react";
import { useSession } from "./useSession";

interface GateProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function Authenticated({ children, fallback = null }: GateProps) {
  const { status } = useSession();
  return status === "authenticated" ? <>{children}</> : <>{fallback}</>;
}

export function Unauthenticated({ children, fallback = null }: GateProps) {
  const { status } = useSession();
  return status === "anonymous" ? <>{children}</> : <>{fallback}</>;
}

export function SessionLoading({ children, fallback = null }: GateProps) {
  const { status } = useSession();
  return status === "pending" ? <>{children}</> : <>{fallback}</>;
}
