import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/client.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  splitting: true,
  treeshake: true,
  external: [
    "@parcae/backend",
    "@parcae/model",
    "@parcae/sdk",
    "better-auth",
    "better-auth/api",
    "better-auth/oauth2",
    "better-auth/plugins/bearer",
    "better-auth/plugins/generic-oauth",
    "pg",
  ],
});
