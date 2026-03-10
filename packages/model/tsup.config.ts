import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/adapters/types.ts", "src/adapters/client.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  splitting: true,
  treeshake: true,
  noExternal: ["fast-json-patch"],
});
