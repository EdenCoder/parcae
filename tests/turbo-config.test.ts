import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface TurboConfig {
  tasks?: {
    test?: {
      env?: string[];
    };
  };
}

describe("turbo configuration", () => {
  it("passes the analytics integration database to test tasks", async () => {
    const path = new URL("../turbo.json", import.meta.url);
    const config = JSON.parse(await readFile(path, "utf8")) as TurboConfig;

    expect(config.tasks?.test?.env).toContain("ANALYTICS_TEST_DB");
  });
});
