import { describe, expect, it } from "vitest";
import { run } from "./cli.js";

describe("run", () => {
  it("prints usage to stdout and exits 0 for --help", () => {
    const result = run(["--help"]);

    expect(result.stream).toBe("stdout");
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/^Usage: talentscout/);
  });

  it("prints usage to stdout and exits 0 for -h", () => {
    const result = run(["-h"]);

    expect(result.stream).toBe("stdout");
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/^Usage: talentscout/);
  });

  it("prints usage to stdout and exits 0 for no arguments", () => {
    const result = run([]);

    expect(result.stream).toBe("stdout");
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/^Usage: talentscout/);
  });

  it("prints usage to stderr, names the flag, and exits 1 for an unknown flag", () => {
    const result = run(["--bogus"]);

    expect(result.stream).toBe("stderr");
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("--bogus");
    expect(result.text).toContain("Usage:");
    expect(result.text).not.toContain("    at ");
  });
});
