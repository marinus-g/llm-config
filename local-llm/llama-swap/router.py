#!/usr/bin/env python3
"""Local llama-swap router.

Keeps port 5099 stable for opencode while llama-swap runs behind it on 5100.
The router rewrites a public model id to its -cpu shadow only when a different
GPU model is already active.
"""

from __future__ import annotations

import argparse
import http.client
import json
import logging
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit


HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


CPU_SHADOWS = {
    "qwen3-coder": "qwen3-coder-cpu",
    "qwen3-coder-mid": "qwen3-coder-mid-cpu",
    "qwen3-coder-large": "qwen3-coder-large-cpu",
    "qwen3-vl": "qwen3-vl-cpu",
    "qwen3-moe": "qwen3-moe-cpu",
    "qwen3-moe-large": "qwen3-moe-large-cpu",
    "qwen3-moe-vl": "qwen3-moe-vl-cpu",
}


class RouterState:
    def __init__(self, backend: str, api_key: str, promote_interval: int, gpu_idle_grace: float) -> None:
        parsed = urlsplit(backend)
        self.backend_host = parsed.hostname or "127.0.0.1"
        self.backend_port = parsed.port or 5100
        self.api_key = api_key
        self.promote_interval = promote_interval
        self.gpu_idle_grace = gpu_idle_grace
        self._promotion_lock = threading.Lock()
        self._activity_lock = threading.Lock()
        self._gpu_inflight = 0
        self._last_gpu_finished_at = time.monotonic()
        self._gpu_prefer_until: dict[str, float] = {}
        self._gpu_context_tokens: dict[str, int] = {}

    def backend_connection(self, timeout: float = 300.0) -> http.client.HTTPConnection:
        return http.client.HTTPConnection(self.backend_host, self.backend_port, timeout=timeout)

    def running_models(self) -> list[dict[str, Any]]:
        conn = self.backend_connection(timeout=2.0)
        try:
            conn.request("GET", "/running", headers=self.auth_headers())
            response = conn.getresponse()
            payload = response.read()
            if response.status >= 400:
                return []
            data = json.loads(payload.decode("utf-8") or "{}")
            running = data.get("running", [])
            return running if isinstance(running, list) else []
        except Exception:
            return []
        finally:
            conn.close()

    def auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    @staticmethod
    def active_model_names(running: list[dict[str, Any]]) -> set[str]:
        active: set[str] = set()
        ignored_states = {"stopped", "exited", "error", "failed"}
        for entry in running:
            model = entry.get("model")
            state = str(entry.get("state", "ready")).lower()
            if isinstance(model, str) and state not in ignored_states:
                active.add(model)
        return active

    @staticmethod
    def canonical_model(model: str) -> str:
        if "/" in model:
            model = model.rsplit("/", 1)[1]
        return model.removesuffix("-cpu")

    @staticmethod
    def is_orchestrator_model(model: str) -> bool:
        return RouterState.canonical_model(model) == "qwen3-moe-large"

    @staticmethod
    def estimate_context_tokens(payload: Any) -> int:
        # Cheap tokenizer-free estimate. Good enough for routing relative prompt size.
        text = json.dumps(payload.get("messages", []), ensure_ascii=False, separators=(",", ":"))
        text += json.dumps(payload.get("tools", []), ensure_ascii=False, separators=(",", ":"))
        return max(1, len(text) // 4)

    def gpu_busy(self) -> bool:
        with self._activity_lock:
            if self._gpu_inflight > 0:
                return True
            return time.monotonic() - self._last_gpu_finished_at < self.gpu_idle_grace

    def gpu_inflight(self) -> bool:
        with self._activity_lock:
            return self._gpu_inflight > 0

    def start_gpu_request(self, model: str, context_tokens: int) -> None:
        model = self.canonical_model(model)
        with self._activity_lock:
            self._gpu_inflight += 1
            self._gpu_context_tokens[model] = max(context_tokens, self._gpu_context_tokens.get(model, 0))

    def finish_gpu_request(self) -> None:
        with self._activity_lock:
            self._gpu_inflight = max(0, self._gpu_inflight - 1)
            self._last_gpu_finished_at = time.monotonic()

    def prefer_gpu_for(self, model: str, ttl: float = 30.0) -> None:
        if "/" in model:
            model = model.rsplit("/", 1)[1]
        if model.endswith("-cpu"):
            model = model[:-4]
        with self._activity_lock:
            self._gpu_prefer_until[model] = time.monotonic() + ttl

    def consume_gpu_preference(self, model: str) -> bool:
        now = time.monotonic()
        with self._activity_lock:
            for existing, expires_at in list(self._gpu_prefer_until.items()):
                if expires_at <= now:
                    del self._gpu_prefer_until[existing]
            expires_at = self._gpu_prefer_until.pop(model, None)
            return expires_at is not None and expires_at > now

    def max_active_gpu_context(self, active_gpu: set[str]) -> int:
        with self._activity_lock:
            return max((self._gpu_context_tokens.get(self.canonical_model(model), 0) for model in active_gpu), default=0)

    def routed_model(self, requested: str, used_context_tokens: int, prefer_gpu: bool = False) -> str:
        if requested.endswith("-cpu"):
            return requested

        requested_model = self.canonical_model(requested)
        cpu_shadow = CPU_SHADOWS.get(requested_model)
        active = self.active_model_names(self.running_models())
        active_gpu = {model for model in active if not model.endswith("-cpu")}
        active_context = self.max_active_gpu_context(active_gpu)
        wants_gpu = prefer_gpu or self.consume_gpu_preference(requested)

        if cpu_shadow is None:
            return requested

        if not active_gpu:
            return requested

        if requested in active_gpu:
            return requested

        if wants_gpu:
            logging.info("preferring GPU for %s by explicit request", requested)
            return requested

        if used_context_tokens > active_context:
            logging.info(
                "preferring GPU for %s: request context ~%s tokens > active GPU context ~%s tokens",
                requested_model,
                used_context_tokens,
                active_context,
            )
            return requested

        if (
            not self.gpu_inflight()
            and not self.is_orchestrator_model(requested_model)
            and active_gpu
            and all(self.is_orchestrator_model(model) for model in active_gpu)
        ):
            logging.info("preferring GPU for %s over idle orchestrator %s", requested, ", ".join(sorted(active_gpu)))
            return requested

        if self.gpu_inflight():
            return cpu_shadow

        if self.is_orchestrator_model(requested_model):
            return cpu_shadow

        if active_context == 0 and wants_gpu:
            logging.info("preferring GPU for %s while %s is loaded but idle", requested, ", ".join(sorted(active_gpu)))
            return requested

        if not self.gpu_busy():
            return requested

        return cpu_shadow

    def promote_if_cpu_only(self) -> None:
        if not self._promotion_lock.acquire(blocking=False):
            return
        try:
            active = self.active_model_names(self.running_models())
            cpu_models = sorted(model for model in active if model.endswith("-cpu"))
            if not cpu_models or self.gpu_busy():
                return

            for cpu_model in cpu_models:
                gpu_model = cpu_model[:-4]
                logging.info("promoting %s to %s", cpu_model, gpu_model)
                self._warm_gpu_model(gpu_model)
        finally:
            self._promotion_lock.release()

    def _warm_gpu_model(self, model: str) -> None:
        body = json.dumps(
            {
                "model": model,
                "messages": [{"role": "user", "content": "_"}],
                "max_tokens": 1,
                "stream": False,
            }
        ).encode("utf-8")
        headers = {
            **self.auth_headers(),
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        }
        conn = self.backend_connection(timeout=300.0)
        try:
            conn.request("POST", "/v1/chat/completions", body=body, headers=headers)
            conn.getresponse().read()
        except Exception as exc:
            logging.warning("promotion request for %s failed: %s", model, exc)
        finally:
            conn.close()


def start_promoter(state: RouterState) -> None:
    def loop() -> None:
        while True:
            time.sleep(state.promote_interval)
            state.promote_if_cpu_only()

    thread = threading.Thread(target=loop, name="llama-swap-promoter", daemon=True)
    thread.start()


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "llama-swap-router/1.0"

    @property
    def state(self) -> RouterState:
        return self.server.router_state  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        self._proxy()

    def do_POST(self) -> None:
        if self.path == "/router/prefer-gpu":
            self._handle_prefer_gpu()
            return
        self._proxy()

    def do_OPTIONS(self) -> None:
        self._proxy()

    def do_DELETE(self) -> None:
        self._proxy()

    def log_message(self, fmt: str, *args: Any) -> None:
        logging.info("%s - %s", self.client_address[0], fmt % args)

    def _handle_prefer_gpu(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", "0") or "0"))
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except Exception:
            self.send_error(400, "invalid JSON")
            return

        model = payload.get("model")
        if not isinstance(model, str) or not model:
            self.send_error(400, "missing model")
            return
        if "/" in model:
            model = model.rsplit("/", 1)[1]

        self.state.prefer_gpu_for(model)
        response = json.dumps({"ok": True, "model": model}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def _proxy(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", "0") or "0"))
        path = self.path
        headers = self._forward_headers()
        routed_model: str | None = None
        used_context_tokens = 0

        if self.command == "POST" and path.startswith("/v1/chat/completions"):
            body, routed_model, used_context_tokens = self._maybe_rewrite_chat_body(body)
            headers["Content-Length"] = str(len(body))

        track_gpu_request = routed_model is not None and not routed_model.endswith("-cpu")
        if track_gpu_request:
            self.state.start_gpu_request(routed_model, used_context_tokens)

        conn = self.state.backend_connection()
        # Track whether we have already forwarded the response status/headers to the
        # client.  Once streaming has begun we must NOT call send_error(): injecting a
        # new HTTP status line into the middle of a chunked response body produces
        # corrupt bytes that crash Bun's HTTP parser (null-deref segfault in
        # onAsyncHTTPCallback).  If an upstream error occurs after headers are sent we
        # simply abort the connection cleanly instead.
        response_started = False
        try:
            conn.request(self.command, path, body=body if body else None, headers=headers)
            response = conn.getresponse()
            self.send_response(response.status, response.reason)
            response_headers = response.getheaders()
            has_content_length = any(name.lower() == "content-length" for name, _ in response_headers)
            for name, value in response.getheaders():
                if name.lower() not in HOP_BY_HOP_HEADERS:
                    self.send_header(name, value)
            if not has_content_length:
                self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            response_started = True  # headers flushed; no send_error past this point

            while True:
                chunk = response.read(4096)
                if not chunk:
                    break
                if has_content_length:
                    self.wfile.write(chunk)
                else:
                    self.wfile.write(f"{len(chunk):x}\r\n".encode("ascii"))
                    self.wfile.write(chunk)
                    self.wfile.write(b"\r\n")
                self.wfile.flush()
            if not has_content_length:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            logging.info("client disconnected while proxying %s %s", self.command, path)
        except Exception as exc:
            logging.exception("proxy request failed: %s", exc)
            if response_started:
                # Headers already sent — we cannot inject a new status line without
                # corrupting the stream.  Close the connection; the client will see a
                # truncated/incomplete response and can retry.
                logging.info(
                    "upstream died mid-stream for %s %s; aborting connection to avoid corrupt HTTP",
                    self.command, path,
                )
                try:
                    self.connection.close()
                except Exception:
                    pass
            else:
                try:
                    self.send_error(502, f"llama-swap backend unavailable: {exc}")
                except (BrokenPipeError, ConnectionResetError, socket.timeout):
                    logging.info("client disconnected before proxy error could be sent")
        finally:
            if track_gpu_request:
                self.state.finish_gpu_request()
            conn.close()

    def _forward_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        for name, value in self.headers.items():
            if name.lower() not in HOP_BY_HOP_HEADERS and name.lower() != "host":
                headers[name] = value
        if "Authorization" not in headers:
            headers.update(self.state.auth_headers())
        return headers

    def _maybe_rewrite_chat_body(self, body: bytes) -> tuple[bytes, str | None, int]:
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            return body, None, 0

        requested = payload.get("model")
        if not isinstance(requested, str):
            return body, None, 0

        prefer_gpu = self.headers.get("X-Llama-Swap-Prefer-GPU", "").lower() in {"1", "true", "yes"}
        used_context_tokens = self.state.estimate_context_tokens(payload)
        routed = self.state.routed_model(requested, used_context_tokens, prefer_gpu=prefer_gpu)
        if routed != requested:
            logging.info("routing %s -> %s (request context ~%s tokens)", requested, routed, used_context_tokens)
            payload["model"] = routed
            return json.dumps(payload, separators=(",", ":")).encode("utf-8"), routed, used_context_tokens

        return body, routed, used_context_tokens


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", default="127.0.0.1:5099")
    parser.add_argument("--backend", default="http://127.0.0.1:5100")
    parser.add_argument("--api-key", default="llama-local")
    parser.add_argument("--promote-interval", type=int, default=10)
    parser.add_argument("--gpu-idle-grace", type=float, default=15)
    args = parser.parse_args()

    host, port_text = args.listen.rsplit(":", 1)
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")

    state = RouterState(args.backend, args.api_key, args.promote_interval, args.gpu_idle_grace)
    start_promoter(state)

    server = ThreadingHTTPServer((host, int(port_text)), ProxyHandler)
    server.router_state = state  # type: ignore[attr-defined]
    logging.info("llama-swap router listening on http://%s:%s", host, port_text)
    logging.info("llama-swap backend: %s", args.backend)
    server.serve_forever()


if __name__ == "__main__":
    main()
