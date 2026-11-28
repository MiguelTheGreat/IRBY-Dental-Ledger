"""
Tiny HTTP wrapper around model.py (standard library only - no Flask/FastAPI needed).

    python ocr-model/server.py                # listens on 127.0.0.1:8765
    python ocr-model/server.py --port 9000 --host 0.0.0.0

Then in the web app's .env:
    OCR_PROVIDER=http
    OCR_HTTP_URL=http://127.0.0.1:8765/predict

Endpoints
    GET  /health   -> {"ready": true|false, "starting": true|false, "detail": "..."}
    POST /predict  body = raw image bytes (Content-Type image/jpeg|png|webp)
                   -> JSON returned by model.predict()
"""
import argparse
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model  # noqa: E402

MAX_BYTES = 15 * 1024 * 1024
READY_EVENT = threading.Event()
LOAD_LOCK = threading.Lock()
LOADING = True


def _load_in_background():
    global LOADING
    try:
        model.load()
        ok, detail = model.ready()
        print(f"OCR model loaded ({'ready' if ok else 'NOT READY'}: {detail})", flush=True)
    except Exception:
        traceback.print_exc()
    finally:
        LOADING = False
        READY_EVENT.set()


class Handler(BaseHTTPRequestHandler):
    server_version = "IrbyOCR/2.0"

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            if LOADING and not READY_EVENT.is_set():
                return self._send(200, {
                    "ready": False,
                    "starting": True,
                    "detail": "Loading RapidOCR + Keras document classifier…",
                })
            ok, detail = model.ready()
            return self._send(200, {"ready": ok, "starting": False, "detail": detail})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/predict":
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if not length or length > MAX_BYTES:
            return self._send(413, {"error": "send one image up to 15 MB"})
        image = self.rfile.read(length)
        # If a scan arrives while weights are still warming up, wait for load() to finish
        READY_EVENT.wait(timeout=60)
        started = time.time()
        try:
            result = model.predict(image)
        except Exception as exc:  # report model errors to the web app
            traceback.print_exc()
            return self._send(500, {"error": str(exc)})
        if not isinstance(result, dict):
            result = {"text": str(result)}
        result.setdefault("tookMs", int((time.time() - started) * 1000))
        self._send(200, result)

    def log_message(self, fmt, *args):  # keep image contents out of logs
        sys.stderr.write("[ocr] %s %s\n" % (self.command, self.path))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"OCR model server on http://{args.host}:{args.port}  (loading model in background...)", flush=True)
    threading.Thread(target=_load_in_background, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
