import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "tsup";

const shared = {
  format: ["esm"],
  dts: true,
  sourcemap: true,
  target: "es2022",
  splitting: false,
  treeshake: true,
  external: [
    "@lingui/core",
    "@lingui/react",
    "@parcae/backend",
    "react",
    "react-dom",
  ],
} as const;

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    outDir: "dist",
    clean: true,
  },
  {
    ...shared,
    entry: ["src/backend.ts"],
    outDir: "dist",
    clean: false,
  },
  {
    ...shared,
    entry: ["src/react/index.tsx"],
    outDir: "dist/react",
    clean: false,
    async onSuccess() {
      const file = "dist/react/index.js";
      const contents = readFileSync(file, "utf-8");
      if (!contents.startsWith('"use client";')) {
        writeFileSync(file, `"use client";\n${contents}`, "utf-8");
      }
    },
  },
]);
