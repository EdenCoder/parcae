/**
 * @parcae/auth-betterauth — Client adapter
 *
 * Usage:
 * ```tsx
 * import { betterAuth } from "@parcae/auth-betterauth/client";
 *
 * <ParcaeProvider url="..." auth={betterAuth()}>
 * ```
 */

import { createAuthClient } from "better-auth/react";

interface AuthClientAdapter {
  init(baseUrl: string): void;
  getToken(): Promise<string | null>;
  onChange(callback: (token: string | null) => void): () => void;
}

export function betterAuth(): AuthClientAdapter {
  let client: ReturnType<typeof createAuthClient> | null = null;

  return {
    init(baseUrl: string) {
      client = createAuthClient({
        baseURL: baseUrl,
        basePath: "/v1/auth",
      });
    },

    async getToken(): Promise<string | null> {
      if (!client) return null;
      try {
        const session = await client.getSession();
        return session?.data?.session?.token ?? null;
      } catch {
        return null;
      }
    },

    onChange(callback: (token: string | null) => void): () => void {
      // Better Auth doesn't have a native onChange — poll on visibility change
      const handler = async () => {
        if (document.visibilityState === "visible" && client) {
          try {
            const session = await client.getSession();
            const token = session?.data?.session?.token ?? null;
            callback(token);
          } catch {
            callback(null);
          }
        }
      };
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", handler);
      }
      return () => {
        if (typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", handler);
        }
      };
    },
  };
}
