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
    "better-auth",
    "better-auth/plugins/bearer",
    "pg",
  ],
});
