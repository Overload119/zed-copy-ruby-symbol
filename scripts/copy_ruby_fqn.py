#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_LSP_COMMAND = "bundle exec srb tc --lsp"

# LSP symbol kinds.
SYMBOL_KIND_METHOD = 6
SYMBOL_KIND_FUNCTION = 12
SYMBOL_KIND_MODULE = 2
SYMBOL_KIND_NAMESPACE = 3
SYMBOL_KIND_CLASS = 5
SYMBOL_KIND_STRUCT = 23
SYMBOL_KIND_INTERFACE = 11
SYMBOL_KIND_ENUM = 10


class FqnCopyError(Exception):
    pass


@dataclass
class SymbolCandidate:
    name: str
    kind: int
    start_line: int
    start_char: int
    end_line: int
    end_char: int
    path: List[Tuple[str, int]]
    order: int

    def contains(self, line: int, char: int) -> bool:
        starts_before = (line > self.start_line) or (
            line == self.start_line and char >= self.start_char
        )
        ends_after = (line < self.end_line) or (
            line == self.end_line and char <= self.end_char
        )
        return starts_before and ends_after

    def span_size(self) -> Tuple[int, int]:
        return (self.end_line - self.start_line, self.end_char - self.start_char)


class JsonRpcConnection:
    def __init__(self, process: subprocess.Popen, timeout_seconds: float) -> None:
        self.process = process
        self.timeout_seconds = timeout_seconds
        self.next_id = 1

    def send(self, payload: Dict[str, Any]) -> None:
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        header = f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii")
        assert self.process.stdin is not None
        self.process.stdin.write(header)
        self.process.stdin.write(raw)
        self.process.stdin.flush()

    def request(self, method: str, params: Dict[str, Any]) -> Any:
        request_id = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = time.time() + self.timeout_seconds
        while time.time() < deadline:
            message = self.read_message(deadline - time.time())
            if message is None:
                continue
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise FqnCopyError(f"LSP {method} failed: {message['error']}")
            return message.get("result")
        raise FqnCopyError(f"Timed out waiting for LSP response: {method}")

    def notify(self, method: str, params: Dict[str, Any]) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def read_message(self, timeout_seconds: float) -> Optional[Dict[str, Any]]:
        if timeout_seconds <= 0:
            return None
        assert self.process.stdout is not None
        stdout = self.process.stdout
        start = time.time()
        headers: Dict[str, str] = {}
        while True:
            if time.time() - start >= timeout_seconds:
                return None
            line = stdout.readline()
            if line == b"":
                if self.process.poll() is not None:
                    stderr_text = ""
                    if self.process.stderr is not None:
                        stderr_text = self.process.stderr.read().decode("utf-8", errors="replace")
                    raise FqnCopyError(
                        "Language server process exited unexpectedly."
                        + (f"\n{stderr_text.strip()}" if stderr_text.strip() else "")
                    )
                continue
            if line in (b"\r\n", b"\n"):
                break
            decoded = line.decode("ascii", errors="replace").strip()
            if ":" in decoded:
                key, value = decoded.split(":", 1)
                headers[key.lower().strip()] = value.strip()

        content_length_raw = headers.get("content-length")
        if content_length_raw is None:
            return None
        try:
            content_length = int(content_length_raw)
        except ValueError as exc:
            raise FqnCopyError(f"Invalid Content-Length header: {content_length_raw}") from exc

        body = stdout.read(content_length)
        if not body:
            return None
        return json.loads(body.decode("utf-8"))


def path_to_uri(path: pathlib.Path) -> str:
    return path.resolve().as_uri()


def symbol_range_from_document_symbol(symbol: Dict[str, Any]) -> Optional[Tuple[int, int, int, int]]:
    symbol_range = symbol.get("range")
    if not symbol_range:
        return None
    start = symbol_range.get("start", {})
    end = symbol_range.get("end", {})
    return (
        int(start.get("line", 0)),
        int(start.get("character", 0)),
        int(end.get("line", 0)),
        int(end.get("character", 0)),
    )


def symbol_range_from_symbol_information(symbol: Dict[str, Any]) -> Optional[Tuple[int, int, int, int]]:
    location = symbol.get("location", {})
    symbol_range = location.get("range")
    if not symbol_range:
        return None
    start = symbol_range.get("start", {})
    end = symbol_range.get("end", {})
    return (
        int(start.get("line", 0)),
        int(start.get("character", 0)),
        int(end.get("line", 0)),
        int(end.get("character", 0)),
    )


def flatten_document_symbols(
    symbols: List[Dict[str, Any]],
    parent_path: Optional[List[Tuple[str, int]]] = None,
    order_start: int = 0,
) -> List[SymbolCandidate]:
    if parent_path is None:
        parent_path = []
    flattened: List[SymbolCandidate] = []
    order = order_start
    for symbol in symbols:
        name = str(symbol.get("name", "")).strip()
        kind = int(symbol.get("kind", 0))
        symbol_range = symbol_range_from_document_symbol(symbol)
        if not name or symbol_range is None:
            continue
        start_line, start_char, end_line, end_char = symbol_range
        current = SymbolCandidate(
            name=name,
            kind=kind,
            start_line=start_line,
            start_char=start_char,
            end_line=end_line,
            end_char=end_char,
            path=parent_path + [(name, kind)],
            order=order,
        )
        flattened.append(current)
        order += 1
        children = symbol.get("children") or []
        if isinstance(children, list) and children:
            child_candidates = flatten_document_symbols(children, current.path, order)
            flattened.extend(child_candidates)
            if child_candidates:
                order = max(order, max(c.order for c in child_candidates) + 1)
    return flattened


def flatten_symbol_information(symbols: List[Dict[str, Any]]) -> List[SymbolCandidate]:
    flattened: List[SymbolCandidate] = []
    for order, symbol in enumerate(symbols):
        name = str(symbol.get("name", "")).strip()
        kind = int(symbol.get("kind", 0))
        symbol_range = symbol_range_from_symbol_information(symbol)
        if not name or symbol_range is None:
            continue
        start_line, start_char, end_line, end_char = symbol_range
        flattened.append(
            SymbolCandidate(
                name=name,
                kind=kind,
                start_line=start_line,
                start_char=start_char,
                end_line=end_line,
                end_char=end_char,
                path=[(name, kind)],
                order=order,
            )
        )
    return flattened


def choose_symbol_at_cursor(candidates: List[SymbolCandidate], line: int, char: int) -> SymbolCandidate:
    containing = [candidate for candidate in candidates if candidate.contains(line, char)]
    if not containing:
        raise FqnCopyError("No symbol contains the current cursor position.")
    # Smallest containing range first, then stable source order.
    containing.sort(key=lambda c: (c.span_size()[0], c.span_size()[1], c.order))
    return containing[0]


def kind_is_method(kind: int) -> bool:
    return kind in {SYMBOL_KIND_METHOD, SYMBOL_KIND_FUNCTION}


def kind_is_namespace(kind: int) -> bool:
    return kind in {
        SYMBOL_KIND_MODULE,
        SYMBOL_KIND_NAMESPACE,
        SYMBOL_KIND_CLASS,
        SYMBOL_KIND_STRUCT,
        SYMBOL_KIND_INTERFACE,
        SYMBOL_KIND_ENUM,
    }


def build_ruby_fqn(symbol: SymbolCandidate) -> str:
    if not symbol.path:
        raise FqnCopyError("Unable to build FQN because symbol path is empty.")
    names = [name for name, _kind in symbol.path]
    kinds = [kind for _name, kind in symbol.path]

    target_name = names[-1]
    target_kind = kinds[-1]
    namespaces = [name for name, kind in zip(names[:-1], kinds[:-1]) if kind_is_namespace(kind)]

    if kind_is_method(target_kind):
        if namespaces:
            return "::".join(namespaces) + "." + target_name
        return target_name

    if namespaces:
        return "::".join(namespaces + [target_name])
    return target_name


def copy_to_clipboard(text: str) -> None:
    if sys.platform != "darwin":
        raise FqnCopyError("Clipboard copy is currently supported on macOS only (pbcopy).")
    proc = subprocess.run(
        ["pbcopy"],
        input=text.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        stderr_text = proc.stderr.decode("utf-8", errors="replace").strip()
        raise FqnCopyError(f"pbcopy failed: {stderr_text or 'unknown error'}")


def start_lsp(command: str) -> subprocess.Popen:
    args = shlex.split(command)
    if not args:
        raise FqnCopyError("LSP command is empty.")
    try:
        return subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise FqnCopyError(f"Unable to start LSP command: {command}") from exc


def query_symbols(
    file_path: pathlib.Path,
    file_text: str,
    lsp_command: str,
    timeout_seconds: float,
) -> List[SymbolCandidate]:
    process = start_lsp(lsp_command)
    conn = JsonRpcConnection(process=process, timeout_seconds=timeout_seconds)
    uri = path_to_uri(file_path)
    worktree_root = os.getenv("ZED_WORKTREE_ROOT") or str(file_path.parent)
    root_uri = pathlib.Path(worktree_root).resolve().as_uri()

    try:
        conn.request(
            "initialize",
            {
                "processId": None,
                "clientInfo": {"name": "zed-copy-ruby-symbol", "version": "0.1.0"},
                "rootUri": root_uri,
                "capabilities": {},
                "workspaceFolders": [{"uri": root_uri, "name": pathlib.Path(worktree_root).name}],
            },
        )
        conn.notify("initialized", {})
        conn.notify(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": uri,
                    "languageId": "ruby",
                    "version": 1,
                    "text": file_text,
                }
            },
        )
        result = conn.request("textDocument/documentSymbol", {"textDocument": {"uri": uri}})
        if result is None:
            raise FqnCopyError("Language server returned no symbols.")
        if not isinstance(result, list):
            raise FqnCopyError("Unexpected documentSymbol response shape.")

        if result and isinstance(result[0], dict) and "children" in result[0]:
            return flatten_document_symbols(result)
        return flatten_symbol_information(result)
    finally:
        try:
            conn.request("shutdown", {})
        except Exception:
            pass
        try:
            conn.notify("exit", {})
        except Exception:
            pass
        try:
            process.terminate()
        except Exception:
            pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Copy Ruby fully qualified symbol name at cursor.")
    parser.add_argument("--file", required=True, help="Absolute file path.")
    parser.add_argument("--row", required=True, type=int, help="1-based row from Zed.")
    parser.add_argument("--column", required=True, type=int, help="1-based column from Zed.")
    parser.add_argument(
        "--lsp-command",
        default=DEFAULT_LSP_COMMAND,
        help=f"LSP command (default: {DEFAULT_LSP_COMMAND!r})",
    )
    parser.add_argument(
        "--timeout-seconds",
        default=12.0,
        type=float,
        help="LSP request timeout.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    file_path = pathlib.Path(args.file)
    if not file_path.exists():
        print(f"error: file does not exist: {file_path}", file=sys.stderr)
        return 1

    try:
        file_text = file_path.read_text(encoding="utf-8")
        # Zed task variables are 1-based; LSP positions are 0-based.
        line = max(args.row - 1, 0)
        char = max(args.column - 1, 0)

        candidates = query_symbols(
            file_path=file_path,
            file_text=file_text,
            lsp_command=args.lsp_command,
            timeout_seconds=args.timeout_seconds,
        )
        symbol = choose_symbol_at_cursor(candidates, line, char)
        fqn = build_ruby_fqn(symbol)
        copy_to_clipboard(fqn)
        print(fqn)
        return 0
    except FqnCopyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"error: unexpected failure: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
