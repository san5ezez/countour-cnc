"""Serve the machine controls on the loopback interface."""

import argparse
import errno
import json
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from program_edit import scale_xy, transform_xy
from sender import MAX_PROGRAM_BYTES, Sender, parse_program, serial_ports

ROOT = Path(__file__).resolve().parent
VERSION = "0.2.11"
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/plot.js": ("plot.js", "text/javascript; charset=utf-8"),
    "/icons.svg": ("icons.svg", "image/svg+xml"),
}


class LocalHandler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def reply(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(body)

    def json_response(self, status, data):
        self.reply(status, json.dumps(data, ensure_ascii=False, allow_nan=False).encode(), "application/json; charset=utf-8")

    def allowed(self):
        origin = self.headers.get("Origin")
        hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        host = self.headers.get("Host")
        return host in hosts and origin in {None, f"http://{host}"}

    def do_GET(self):
        if not self.allowed():
            self.send_error(403)
            return
        if self.path == "/api/state":
            self.json_response(200, self.server.sender.snapshot())
        elif self.path == "/api/features":
            self.json_response(200, {"editor": self.server.test_mode, "version": VERSION})
        elif self.path == "/api/file":
            self.json_response(200, self.server.sender.file_info())
        elif self.path == "/api/ports":
            ports, available = serial_ports()
            self.json_response(200, {"ports": ports, "serialAvailable": available})
        elif self.path in STATIC:
            filename, content_type = STATIC[self.path]
            body = (ROOT / "web" / filename).read_bytes()
            if self.path == "/":
                mode = b"test" if self.server.test_mode else b"standard"
                body = body.replace(b"{{launch-mode}}", mode).replace(b"{{version}}", VERSION.encode("ascii"))
            self.reply(200, body, content_type)
        elif self.path == "/editor.js" and self.server.test_mode:
            self.reply(200, (ROOT / "web" / "editor.js").read_bytes(), "text/javascript; charset=utf-8")
        else:
            self.send_error(404)

    def do_POST(self):
        if not self.allowed() or self.headers.get("X-CNC-Panel") != "local":
            self.send_error(403)
            return
        edit = self.server.test_mode and self.path in ("/api/validate", "/api/scale", "/api/transform")
        if self.path != "/api/action" and not edit:
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > MAX_PROGRAM_BYTES * 6 + 4096:
                raise ValueError("Недопустимый размер запроса.")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("Неверный формат команды.")
            if self.path == "/api/validate":
                result = {"lines": len(parse_program(data.get("source")))}
            elif self.path == "/api/scale":
                source = scale_xy(data.get("source"), data.get("factor"))
                result = {"source": source, "lines": len(parse_program(source))}
            elif self.path == "/api/transform":
                source, selected, rows = transform_xy(data.get("source"), data.get("factor"), data.get("angle"),
                                                data.get("dx"), data.get("dy"), data.get("pivot"),
                                                data.get("selection"), data.get("selectedLines"))
                result = {"source": source, "selectedLines": selected, "selectedRows": rows}
            else:
                result = self.server.sender.command(data.get("action"), data)
        except (ValueError, OSError) as error:
            self.json_response(400, {"error": str(error)})
        else:
            self.json_response(200, result)


def main():
    parser = argparse.ArgumentParser(description="Контур — локальный G-code Sender для GRBL 1.1")
    parser.add_argument("--port", type=int, help="порт панели (по умолчанию 8765, для --test 8766)")
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер автоматически")
    parser.add_argument("--test", action="store_true", help="включить экспериментальный редактор G-кода")
    args = parser.parse_args()
    port = args.port if args.port is not None else (8766 if args.test else 8765)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), LocalHandler)
    except OSError as error:
        if error.errno != errno.EADDRINUSE and getattr(error, "winerror", None) not in (10013, 10048):
            raise
        if args.test and args.port is None:
            server = ThreadingHTTPServer(("127.0.0.1", 0), LocalHandler)
        else:
            parser.exit(1, f"Порт {port} занят или недоступен. Закройте предыдущий запуск или выберите другой порт через --port.\n")
    with server:
        sender = Sender(ROOT / "examples" / "rosette.nc")
        sender.command("connect", {"port": "simulator", "baud": 115200})
        server.sender = sender
        server.test_mode = args.test
        url = f"http://127.0.0.1:{server.server_port}"
        mode = " TEST" if args.test else ""
        print(f"Контур CNC {VERSION}{mode} · {url}", flush=True)
        if not args.no_browser:
            threading.Timer(0.35, webbrowser.open, args=(url,)).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            sender.close()


if __name__ == "__main__":
    main()
