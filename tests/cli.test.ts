import { spawn } from "child_process";
import { resolve } from "path";

const EXAMPLES_DIR = resolve(__dirname, "..", "example");

async function build(): Promise<void> {
  const { stdout, stderr, exitCode } = Bun.spawnSync(["bun", "run", "build"], {
    cwd: resolve(__dirname, ".."),
  });
  if (exitCode !== 0) {
    throw new Error(
      `build failed:\n${stderr.toString()}\n${stdout.toString()}`
    );
  }
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binPath = resolve(__dirname, "..", "bin", "copy-ruby-reference");
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

async function main() {
  await build();

  const tests = [
    {
      name: "class constant in MyFile",
      args: ["--file", "file.rb", "--row", "4", "--column", "5"],
      expectedExit: 0,
      expectedOutput: "MyFile::MY_CONTEXT",
    },
    {
      name: "top-level module",
      args: ["--file", "edge_cases.rb", "--row", "14", "--column", "2"],
      expectedExit: 0,
      expectedOutput: "TopLevelModule",
    },
    {
      name: "class method",
      args: ["--file", "edge_cases.rb", "--row", "4", "--column", "12"],
      expectedExit: 0,
      expectedOutput: "EdgeCaseClass",
    },
    {
      name: "instance method",
      args: ["--file", "edge_cases.rb", "--row", "7", "--column", "12"],
      expectedExit: 0,
      expectedOutput: "EdgeCaseClass",
    },
    {
      name: "nested module",
      args: ["--file", "namespace_test.rb", "--row", "4", "--column", "2"],
      expectedExit: 0,
      expectedOutput: "TestNamespace",
    },
    {
      name: "nested method",
      args: ["--file", "namespace_test.rb", "--row", "5", "--column", "9"],
      expectedExit: 0,
      expectedOutput: "TestNamespace::NestedNamespace.my_method",
    },
    {
      name: "missing file",
      args: ["--file", "nonexistent.rb", "--row", "1", "--column", "1"],
      expectedExit: 1,
      expectedOutput: null,
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    const result = await run(test.args);

    if (result.exitCode !== test.expectedExit) {
      console.error(`FAIL: ${test.name}`);
      console.error(`  Expected exit ${test.expectedExit}, got ${result.exitCode}`);
      console.error(`  stderr: ${result.stderr}`);
      failed++;
      continue;
    }

    if (test.expectedOutput !== null && !result.stdout.includes(test.expectedOutput)) {
      console.error(`FAIL: ${test.name}`);
      console.error(`  Expected output to contain: ${test.expectedOutput}`);
      console.error(`  Got: ${result.stdout}`);
      failed++;
      continue;
    }

    console.log(`PASS: ${test.name}`);
    passed++;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
