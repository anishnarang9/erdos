import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const path = (file: string) => new URL(`../public/site/${file}`, import.meta.url);
const read = (file: string) => readFileSync(path(file), "utf8");

it("publishes role instructions without tasks, fixtures, or sample listings", () => {
  const guide = read("agents.html");
  expect(guide).toContain('id="buyer"');
  expect(guide).toContain('id="solver"');
  expect(guide).toContain("current chat");
  for (const file of ["meridian.md", "api/open-jobs.json"]) {
    expect(existsSync(path(file)), file).toBe(false);
  }
  for (const file of ["agents.html", "demo.html", "index.html", "market.js", "demo-page.js"]) {
    expect(read(file), file).not.toMatch(/meridian|open-jobs\.json|fresh-exchange-input/i);
  }
  expect(guide).not.toMatch(/data-sample|demo-lab\.js|recorded-invoice\.json/i);
});
