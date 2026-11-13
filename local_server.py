import base64
import json
import os
import re
import secrets
import subprocess
import sys
import uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer

PROJECT_DIR = Path(__file__).resolve().parent
TRANSLATOR = PROJECT_DIR / "translate_grouped.py"
UPLOAD_DIR = PROJECT_DIR / ".uploads"
KEY_FILE = PROJECT_DIR / ".server_key"

HOST = "0.0.0.0"
PORT = 8765
MAX_UPLOAD = 15 * 1024 * 1024
MAX_REQUEST = ((MAX_UPLOAD + 2) // 3) * 4 + 10000

UPLOAD_DIR.mkdir(exist_ok=True)

if not KEY_FILE.exists():
    KEY_FILE.write_text(secrets.token_urlsafe(32) + "\n")
    os.chmod(KEY_FILE, 0o600)

API_KEY = KEY_FILE.read_text().strip()


class TranslatorHandler(BaseHTTPRequestHandler):

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_json(200, {"status": "ok"})

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {
                "status": "online",
                "translator": TRANSLATOR.exists()
            })
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/translate":
            self.send_json(404, {"error": "Not found"})
            return

        if self.headers.get("X-API-Key", "") != API_KEY:
            self.send_json(401, {"status": "error", "error": "Invalid API key"})
            return

        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"status": "error", "error": "Invalid content length"})
            return

        if size <= 0 or size > MAX_REQUEST:
            self.send_json(413, {"status": "error", "error": "Invalid request size"})
            return

        if not TRANSLATOR.exists():
            self.send_json(500, {"status": "error", "error": "Translator script not found"})
            return

        image_path = None

        try:
            raw_body = self.rfile.read(size)

            if len(raw_body) != size:
                self.send_json(400, {"status": "error", "error": "Incomplete request"})
                return

            payload = json.loads(raw_body.decode("utf-8"))

            filename = str(payload.get("filename", "upload.png"))
            filename = re.sub(r"[^a-zA-Z0-9._-]", "_", filename)

            suffix = Path(filename).suffix.lower()

            if suffix not in (".png", ".jpg", ".jpeg", ".webp"):
                self.send_json(400, {"status": "error", "error": "Unsupported image format"})
                return

            encoded = payload.get("image_base64", "")

            if not isinstance(encoded, str) or not encoded:
                self.send_json(400, {"status": "error", "error": "Missing image data"})
                return

            image_data = base64.b64decode(encoded, validate=True)

            if not image_data or len(image_data) > MAX_UPLOAD:
                self.send_json(413, {"status": "error", "error": "Image must be between 1 byte and 15 MB"})
                return

            image_path = UPLOAD_DIR / ("upload_" + uuid.uuid4().hex + suffix)
            image_path.write_bytes(image_data)

            print(f"[Server] Received {filename}: {len(image_data)} bytes", flush=True)

            result = subprocess.run(
                [sys.executable, str(TRANSLATOR), str(image_path)],
                cwd=str(PROJECT_DIR),
                capture_output=True,
                text=True,
                timeout=300
            )

            if result.returncode != 0:
                self.send_json(500, {
                    "status": "error",
                    "error": "Translation process failed",
                    "details": result.stderr[-4000:],
                    "output": result.stdout[-4000:]
                })
                return

            try:
                translation_data = json.loads(result.stdout)
            except json.JSONDecodeError:
                self.send_json(500, {
                    "status": "error",
                    "error": "Translator returned invalid JSON",
                    "details": result.stderr[-4000:],
                    "output": result.stdout[-4000:]
                })
                return

            if translation_data.get("status") != "success":
                self.send_json(422, {
                    "status": "error",
                    "error": "Image translation failed",
                    "result": translation_data
                })
                return

            self.send_json(200, {
                "status": "success",
                "filename": filename,
                "image_bytes": len(image_data),
                "result": translation_data
            })

        except subprocess.TimeoutExpired:
            self.send_json(504, {
                "status": "error",
                "error": "Translation timed out"
            })

        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {
                "status": "error",
                "error": f"Invalid image request: {error}"
            })

        except Exception as error:
            self.send_json(500, {
                "status": "error",
                "error": str(error)
            })

        finally:
            if image_path and image_path.exists():
                image_path.unlink()

    def log_message(self, format, *args):
        print("[Server]", format % args)


if __name__ == "__main__":
    print("====================================")
    print(" MANHWA TRANSLATOR LOCAL SERVER")
    print("====================================")
    print(f"Listening on port {PORT}")
    print("Press CTRL+C to stop.")

    HTTPServer((HOST, PORT), TranslatorHandler).serve_forever()
