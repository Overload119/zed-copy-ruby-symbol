import { spawn } from "child_process";
import { resolve } from "path";
import { test, expect } from "bun:test";

const EXAMPLES_DIR = resolve(__dirname, "..", "example");
const binPath = resolve(__dirname, "..", "bin", "copy-ruby-reference");

function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, args, { cwd: EXAMPLES_DIR });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    proc.on("error", reject);
  });
}

test("class constant in MyFile", async () => {
  const result = await run(["--file", "file.rb", "--row", "4", "--column", "5"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("MyFile::MY_CONTEXT");
});

test("top-level module", async () => {
  const result = await run(["--file", "edge_cases.rb", "--row", "14", "--column", "2"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("TopLevelModule");
});

test("class method", async () => {
  const result = await run(["--file", "edge_cases.rb", "--row", "4", "--column", "12"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("EdgeCaseClass");
});

test("instance method", async () => {
  const result = await run(["--file", "edge_cases.rb", "--row", "7", "--column", "12"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("EdgeCaseClass");
});

test("nested module", async () => {
  const result = await run(["--file", "namespace_test.rb", "--row", "4", "--column", "2"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("TestNamespace");
});

test("nested method", async () => {
  const result = await run(["--file", "namespace_test.rb", "--row", "5", "--column", "9"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("TestNamespace::NestedNamespace.my_method");
});

test("missing file", async () => {
  const result = await run(["--file", "nonexistent.rb", "--row", "1", "--column", "1"]);
  expect(result.exitCode).toBe(1);
});
