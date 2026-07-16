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
    def __init__(
        self,
        backend: str,
        api_key: str,
        promote_interval: int,
        gpu_idle_grace: float,
        swap_max_wait: float = 30.0,
        swap_poll_interval: float = 0.5,
    ) -> None:
        parsed = urlsplit(backend)
        self.backend_host = parsed.hostname or "127.0.0.1"
        self.backend_port = parsed.port or 5100
        self.api_key = api_key
        self.promote_interval = promote_interval
        self.gpu_idle_grace = gpu_idle_grace
        self.swap_max_wait = swap_max_wait
        self.swap_poll_interval = swap_poll_interval
        self._promotion_lock = threading.Lock()
        self._activity_lock = threading.Lock()
        self._gpu_inflight = 0
        self._last_gpu_finished_at = time.monotonic()
        self._gpu_prefer_until: dict[str, float] = {}
        self._gpu_context_tokens: dict[str, int] = {}
        self._gpu_owner: dict[str, str] = {}  # canonical model → owning client tag

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

    def start_gpu_request(self, model: str, context_tokens: int, client: str = "other") -> None:
        model = self.canonical_model(model)
        with self._activity_lock:
            self._gpu_inflight += 1
            self._gpu_context_tokens[model] = max(context_tokens, self._gpu_context_tokens.get(model, 0))
            self._gpu_owner[model] = client

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

        # Contention is now handled by the swap gate (wait_for_gpu_idle) in _proxy,
        # not by diverting to CPU shadows.  Always forward to the requested GPU model
        # and let the gate hold the connection until the resident model is idle.
        return requested

    def wait_for_gpu_idle(self, requested_model: str, max_wait: float) -> None:
        """Block until the resident GPU model is idle or max_wait elapses.

        Called before forwarding a request that may trigger a model swap.  Prevents
        thrash when a session is mid-tool-call (GPU looks idle to the backend, but
        the client will resume shortly): the competing request waits out the grace
        window instead of forcing an evict/reload cycle.
        """
        requested_canonical = self.canonical_model(requested_model)
        deadline = time.monotonic() + max_wait
        logged = False
        while time.monotonic() < deadline:
            active = self.active_model_names(self.running_models())
            active_gpu = {model for model in active if not model.endswith("-cpu")}
            # Card is free or requested model is already resident — no swap needed.
            if not active_gpu or requested_canonical in {self.canonical_model(m) for m in active_gpu}:
                return
            # Resident model is idle — safe to swap.
            if not self.gpu_busy():
                if logged:
                    logging.info("swap gate: %s proceeding (resident GPU now idle)", requested_model)
                return
            # Resident model is busy — hold the request.
            if not logged:
                logging.info(
                    "swap gate: %s waiting up to %.0fs for resident GPU model to go idle",
                    requested_model,
                    max_wait,
                )
                logged = True
            time.sleep(self.swap_poll_interval)
        logging.info("swap gate: timeout reached for %s, allowing swap", requested_model)

    def release_gpu_grace(self, owner: str = "opencode") -> bool:
        """Expire the idle-grace timer so a swap can happen immediately.

        Only fires when every resident GPU model is owned by *owner*.  If any
        other client's model is resident (idle or not) the grace window is left
        intact so that client's anti-thrash protection is not disturbed.

        Safe to call while `_gpu_inflight > 0`: `gpu_busy()` returns True via the
        inflight branch regardless of the grace timer, so any active stream
        continues uninterrupted — only the soft grace portion is expired.
        """
        active = self.active_model_names(self.running_models())
        active_gpu = {m for m in active if not m.endswith("-cpu")}

        # Card is free — nothing to protect; clear grace unconditionally.
        if not active_gpu:
            with self._activity_lock:
                self._last_gpu_finished_at = time.monotonic() - self.gpu_idle_grace - 1
            logging.info("release-gpu: no GPU models resident, grace cleared")
            return True

        # Check that every resident GPU model belongs to the requesting owner.
        with self._activity_lock:
            for m in active_gpu:
                recorded_owner = self._gpu_owner.get(self.canonical_model(m), "other")
                if recorded_owner != owner:
                    logging.info(
                        "release-gpu: resident model %s owned by %r (not %r), skipping",
                        m, recorded_owner, owner,
                    )
                    return False
            # All resident GPU models are ours — safe to expire grace.
            self._last_gpu_finished_at = time.monotonic() - self.gpu_idle_grace - 1
        logging.info("release-gpu: grace expired for owner=%r (resident: %s)", owner, active_gpu)
        return True

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
        if self.path == "/router/release-gpu":
            self._handle_release_gpu()
            return
        self._proxy()

    def do_OPTIONS(self) -> None:
        self._proxy()

    def do_DELETE(self) -> None:
        self._proxy()

    def log_message(self, fmt: str, *args: Any) -> None:
        logging.info("%s - %s", self.client_address[0], fmt % args)

    def _handle_release_gpu(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", "0") or "0"))
        owner = "opencode"
        try:
            if body:
                payload = json.loads(body.decode("utf-8"))
                if isinstance(payload.get("owner"), str) and payload["owner"]:
                    owner = payload["owner"].strip().lower()
        except Exception:
            pass

        released = self.state.release_gpu_grace(owner)
        response = json.dumps({"ok": True, "released": released}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

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

        # Swap gate: hold the request until the resident GPU model goes idle, so
        # a tool-call pause in another session doesn't cause an immediate evict/reload.
        # Runs before GPU accounting and before opening the backend connection so
        # there is no streaming-corruption risk (no bytes sent to the client yet).
        if (
            self.command == "POST"
            and path.startswith("/v1/chat/completions")
            and routed_model is not None
            and not routed_model.endswith("-cpu")
        ):
            self.state.wait_for_gpu_idle(routed_model, self.state.swap_max_wait)

        # fastcontext-4b always goes to GPU (it evicts the resident primary model).
        # If the GPU load fails before any response bytes are sent, transparently
        # retry on the CPU fallback instead of surfacing a 502 to the client.
        cpu_fallback_model = (
            "fastcontext-4b-cpu"
            if routed_model == "fastcontext-4b"
            else None
        )

        track_gpu_request = routed_model is not None and not routed_model.endswith("-cpu")
        if track_gpu_request:
            client_tag = (self.headers.get("X-Client") or "other").strip().lower()
            self.state.start_gpu_request(routed_model, used_context_tokens, client=client_tag)

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
            elif cpu_fallback_model:
                # GPU load failed before streaming — retry transparently on CPU fallback.
                logging.warning(
                    "fastcontext-4b GPU load failed (%s); retrying on %s",
                    exc,
                    cpu_fallback_model,
                )
                # Release GPU accounting before the fallback (it runs on CPU).
                if track_gpu_request:
                    self.state.finish_gpu_request()
                    track_gpu_request = False
                # conn.close() will be called by the finally block; retry on new conn.
                self._retry_on_cpu_fallback(body, path, cpu_fallback_model)
                return
            else:
                try:
                    self.send_error(502, f"llama-swap backend unavailable: {exc}")
                except (BrokenPipeError, ConnectionResetError, socket.timeout):
                    logging.info("client disconnected before proxy error could be sent")
        finally:
            if track_gpu_request:
                self.state.finish_gpu_request()
            conn.close()

    def _retry_on_cpu_fallback(self, body: bytes, path: str, cpu_model: str) -> None:
        """Retry a failed fastcontext-4b GPU request on the CPU fallback model."""
        try:
            payload = json.loads(body.decode("utf-8"))
            payload["model"] = cpu_model
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        except Exception as exc:
            logging.warning("failed to rewrite body for CPU fallback: %s", exc)

        headers = self._forward_headers()
        headers["Content-Length"] = str(len(body))
        conn = self.state.backend_connection()
        response_started = False
        try:
            conn.request(self.command, path, body=body, headers=headers)
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
            response_started = True

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
            logging.info("client disconnected during CPU fallback for %s", path)
        except Exception as exc:
            logging.exception("CPU fallback request also failed: %s", exc)
            if response_started:
                try:
                    self.connection.close()
                except Exception:
                    pass
            else:
                try:
                    self.send_error(502, f"llama-swap CPU fallback unavailable: {exc}")
                except (BrokenPipeError, ConnectionResetError, socket.timeout):
                    logging.info("client disconnected before CPU fallback error could be sent")
        finally:
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
    parser.add_argument("--gpu-idle-grace", type=float, default=20)
    parser.add_argument(
        "--swap-max-wait",
        type=float,
        default=30.0,
        help="Max seconds to hold a competing GPU request while the resident model is busy (0 = disable gate)",
    )
    parser.add_argument(
        "--swap-poll-interval",
        type=float,
        default=0.5,
        help="Poll cadence (seconds) inside the swap gate",
    )
    args = parser.parse_args()

    host, port_text = args.listen.rsplit(":", 1)
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")

    state = RouterState(
        args.backend,
        args.api_key,
        args.promote_interval,
        args.gpu_idle_grace,
        swap_max_wait=args.swap_max_wait,
        swap_poll_interval=args.swap_poll_interval,
    )
    start_promoter(state)

    server = ThreadingHTTPServer((host, int(port_text)), ProxyHandler)
    server.router_state = state  # type: ignore[attr-defined]
    logging.info("llama-swap router listening on http://%s:%s", host, port_text)
    logging.info("llama-swap backend: %s", args.backend)
    server.serve_forever()


if __name__ == "__main__":
    main()
