import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/react/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  splitting: true,
  treeshake: true,
  external: ["@parcae/model", "react", "react-dom", "valtio"],
});
