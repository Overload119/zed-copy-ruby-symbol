#!/usr/bin/env bun

import { spawn } from "child_process";
import { parseArgs } from "util";
import { resolve } from "path";
import { readFileSync } from "fs";
import { pathToFileURL } from "url";

const DEFAULT_LSP_COMMAND = "bundle exec srb tc --lsp --disable-watchman";

const SYMBOL_KIND_METHOD = 6;
const SYMBOL_KIND_FUNCTION = 12;
const SYMBOL_KIND_MODULE = 2;
const SYMBOL_KIND_NAMESPACE = 3;
const SYMBOL_KIND_CLASS = 5;
const SYMBOL_KIND_STRUCT = 23;
const SYMBOL_KIND_INTERFACE = 11;
const SYMBOL_KIND_ENUM = 10;

interface SymbolCandidate {
  name: string;
  kind: number;
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  path: Array<[string, number]>;
  order: number;
}

function contains(sym: SymbolCandidate, line: number, char: number): boolean {
  const startsBefore =
    line > sym.startLine ||
    (line === sym.startLine && char >= sym.startChar);
  const endsAfter =
    line < sym.endLine || (line === sym.endLine && char <= sym.endChar);
  return startsBefore && endsAfter;
}

function spanSize(sym: SymbolCandidate): [number, number] {
  return [sym.endLine - sym.startLine, sym.endChar - sym.startChar];
}

// --- JSON-RPC over stdio ---

class JsonRpcConnection {
  private process: ReturnType<typeof spawn>;
  private timeoutMs: number;
  private nextId = 1;
  private buffer = Buffer.alloc(0);

  constructor(proc: ReturnType<typeof spawn>, timeoutSeconds: number) {
    this.process = proc;
    this.timeoutMs = timeoutSeconds * 1000;
  }

  send(payload: Record<string, unknown>): void {
    const raw = JSON.stringify(payload);
    const header = `Content-Length: ${Buffer.byteLength(raw, "utf-8")}\r\n\r\n`;
    this.process.stdin!.write(header);
    this.process.stdin!.write(raw);
  }

  async request(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const requestId = this.nextId++;
    this.send({ jsonrpc: "2.0", id: requestId, method, params });

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const message = await this.readMessage(deadline - Date.now());
      if (message === null) continue;
      if ((message as any).id !== requestId) continue;
      if ((message as any).error) {
        throw new Error(
          `LSP ${method} failed: ${JSON.stringify((message as any).error)}`
        );
      }
      return (message as any).result;
    }
    throw new Error(`Timed out waiting for LSP response: ${method}`);
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private readMessage(
    remainingMs: number
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      if (remainingMs <= 0) return resolve(null);

      const timeout = setTimeout(() => {
        cleanup();
        resolve(null);
      }, remainingMs);

      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const result = this.tryParseMessage();
        if (result !== null) {
          cleanup();
          resolve(result);
        }
      };

      const onClose = () => {
        cleanup();
        const stderr = this.process.stderr;
        let stderrText = "";
        if (stderr) {
          stderr.removeAllListeners("data");
        }
        reject(
          new Error(
            `Language server process exited unexpectedly.${stderrText ? "\n" + stderrText : ""}`
          )
        );
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.process.stdout!.removeListener("data", onData);
        this.process.removeListener("close", onClose);
      };

      // Check buffer first in case a previous read left data
      const existing = this.tryParseMessage();
      if (existing !== null) {
        clearTimeout(timeout);
        return resolve(existing);
      }

      this.process.stdout!.on("data", onData);
      this.process.on("close", onClose);
    });
  }

  private tryParseMessage(): Record<string, unknown> | null {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;

    const headerStr = this.buffer.subarray(0, headerEnd).toString("ascii");
    const match = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!match) return null;

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (this.buffer.length < bodyStart + contentLength) return null;

    const body = this.buffer.subarray(bodyStart, bodyStart + contentLength);
    this.buffer = this.buffer.subarray(bodyStart + contentLength);
    return JSON.parse(body.toString("utf-8"));
  }
}

// --- Symbol flattening ---

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface DocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  children?: DocumentSymbol[];
}

interface SymbolInformation {
  name: string;
  kind: number;
  location: { range: LspRange };
}

function flattenDocumentSymbols(
  symbols: DocumentSymbol[],
  parentPath: Array<[string, number]> = [],
  orderStart = 0
): SymbolCandidate[] {
  const flattened: SymbolCandidate[] = [];
  let order = orderStart;

  for (const sym of symbols) {
    const name = (sym.name ?? "").trim();
    const kind = sym.kind ?? 0;
    if (!name || !sym.range) continue;

    const current: SymbolCandidate = {
      name,
      kind,
      startLine: sym.range.start.line,
      startChar: sym.range.start.character,
      endLine: sym.range.end.line,
      endChar: sym.range.end.character,
      path: [...parentPath, [name, kind]],
      order: order++,
    };
    flattened.push(current);

    if (sym.children?.length) {
      const children = flattenDocumentSymbols(sym.children, current.path, order);
      flattened.push(...children);
      if (children.length) {
        order = Math.max(order, Math.max(...children.map((c) => c.order)) + 1);
      }
    }
  }
  return flattened;
}

function flattenSymbolInformation(
  symbols: SymbolInformation[]
): SymbolCandidate[] {
  return symbols
    .map((sym, order): SymbolCandidate | null => {
      const name = (sym.name ?? "").trim();
      const kind = sym.kind ?? 0;
      const range = sym.location?.range;
      if (!name || !range) return null;
      return {
        name,
        kind,
        startLine: range.start.line,
        startChar: range.start.character,
        endLine: range.end.line,
        endChar: range.end.character,
        path: [[name, kind]],
        order,
      };
    })
    .filter((s): s is SymbolCandidate => s !== null);
}

// --- FQN logic ---

function chooseSymbolAtCursor(
  candidates: SymbolCandidate[],
  line: number,
  char: number
): SymbolCandidate {
  const containing = candidates.filter((c) => contains(c, line, char));
  if (containing.length === 0) {
    throw new Error("No symbol contains the current cursor position.");
  }
  containing.sort((a, b) => {
    const [aLines, aChars] = spanSize(a);
    const [bLines, bChars] = spanSize(b);
    return aLines - bLines || aChars - bChars || a.order - b.order;
  });
  return containing[0];
}

function kindIsMethod(kind: number): boolean {
  return kind === SYMBOL_KIND_METHOD || kind === SYMBOL_KIND_FUNCTION;
}

function kindIsNamespace(kind: number): boolean {
  return [
    SYMBOL_KIND_MODULE,
    SYMBOL_KIND_NAMESPACE,
    SYMBOL_KIND_CLASS,
    SYMBOL_KIND_STRUCT,
    SYMBOL_KIND_INTERFACE,
    SYMBOL_KIND_ENUM,
  ].includes(kind);
}

function buildRubyFqn(symbol: SymbolCandidate): string {
  if (symbol.path.length === 0) {
    throw new Error("Unable to build FQN because symbol path is empty.");
  }

  const targetName = symbol.path.at(-1)![0];
  const targetKind = symbol.path.at(-1)![1];
  const namespaces = symbol.path
    .slice(0, -1)
    .filter(([, kind]) => kindIsNamespace(kind))
    .map(([name]) => name);

  if (kindIsMethod(targetKind)) {
    return namespaces.length
      ? namespaces.join("::") + "." + targetName
      : targetName;
  }

  return namespaces.length
    ? [...namespaces, targetName].join("::")
    : targetName;
}

// --- Clipboard ---

async function copyToClipboard(text: string): Promise<void> {
  const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
  proc.stdin.write(text);
  proc.stdin.end();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`pbcopy failed with exit code ${exitCode}`);
  }
}

// --- LSP query ---

async function querySymbols(
  filePath: string,
  fileText: string,
  lspCommand: string,
  timeoutSeconds: number
): Promise<SymbolCandidate[]> {
  const args = lspCommand.split(/\s+/);
  const proc = spawn(args[0], args.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const conn = new JsonRpcConnection(proc, timeoutSeconds);
  const uri = pathToFileURL(resolve(filePath)).href;
  const worktreeRoot = process.env.ZED_WORKTREE_ROOT || resolve(filePath, "..");
  const rootUri = pathToFileURL(resolve(worktreeRoot)).href;
  const rootName = resolve(worktreeRoot).split("/").pop()!;

  try {
    await conn.request("initialize", {
      processId: null,
      clientInfo: { name: "copy-ruby-reference", version: "0.1.0" },
      rootUri,
      capabilities: {},
      workspaceFolders: [{ uri: rootUri, name: rootName }],
    });

    conn.notify("initialized", {});
    conn.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "ruby",
        version: 1,
        text: fileText,
      },
    });

    const result = (await conn.request("textDocument/documentSymbol", {
      textDocument: { uri },
    })) as any[];

    if (!result || !Array.isArray(result)) {
      throw new Error("Language server returned no symbols.");
    }

    if (result.length > 0 && "children" in result[0]) {
      return flattenDocumentSymbols(result as DocumentSymbol[]);
    }
    return flattenSymbolInformation(result as SymbolInformation[]);
  } finally {
    try {
      await conn.request("shutdown", {});
    } catch {}
    try {
      conn.notify("exit", {});
    } catch {}
    try {
      proc.kill();
    } catch {}
  }
}

// --- Main ---

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      file: { type: "string" },
      row: { type: "string" },
      column: { type: "string" },
      "lsp-command": { type: "string", default: DEFAULT_LSP_COMMAND },
      "timeout-seconds": { type: "string", default: "12" },
    },
    strict: true,
  });

  if (!values.file || !values.row || !values.column) {
    console.error("error: --file, --row, and --column are required");
    return 1;
  }

  const filePath = resolve(values.file);
  const row = parseInt(values.row, 10);
  const column = parseInt(values.column, 10);
  const lspCommand = values["lsp-command"]!;
  const timeoutSeconds = parseFloat(values["timeout-seconds"]!);

  let fileText: string;
  try {
    fileText = readFileSync(filePath, "utf-8");
  } catch {
    console.error(`error: file does not exist: ${filePath}`);
    return 1;
  }

  try {
    // Zed task variables are 1-based; LSP positions are 0-based.
    const line = Math.max(row - 1, 0);
    const char = Math.max(column - 1, 0);

    const candidates = await querySymbols(
      filePath,
      fileText,
      lspCommand,
      timeoutSeconds
    );
    const symbol = chooseSymbolAtCursor(candidates, line, char);
    const fqn = buildRubyFqn(symbol);
    await copyToClipboard(fqn);
    console.log(fqn);
    return 0;
  } catch (err: any) {
    console.error(`error: ${err.message}`);
    return 1;
  }
}

process.exit(await main());
