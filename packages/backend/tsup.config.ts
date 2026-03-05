import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  splitting: true,
  treeshake: true,
  external: [
    "@parcae/model",
    "pg",
    "knex",
    "socket.io",
    "bullmq",
    "ioredis",
    "better-auth",
  ],
});
