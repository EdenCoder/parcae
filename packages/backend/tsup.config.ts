import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "node",
  splitting: true,
  treeshake: true,
  // The CLI entry (src/cli/index.ts) starts with `#!/usr/bin/env node` —
  // tsup preserves that shebang on the compiled bin.
  external: [
    "@parcae/model",
    "knex",
    "socket.io",
    "bullmq",
    "ioredis",
  ],
});
