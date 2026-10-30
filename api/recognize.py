"""Vercel Python Function entry point for page recognition."""

import json
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        payload = json.dumps(
            {"error": "Распознавание пока не подключено."},
            ensure_ascii=False,
        ).encode("utf-8")
        self.send_response(501)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
