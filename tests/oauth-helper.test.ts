import { execFileSync } from "node:child_process";
import test from "node:test";

test("V2-owned OAuth helper preserves V1 AT-first requests and secret-free errors", () => {
  execFileSync("python3", ["-B", "tests/oauth-probe.test.py"], { cwd: process.cwd(), stdio: "pipe" });
});
