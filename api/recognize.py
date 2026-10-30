"""One Vercel Python Function for recognition requests."""

import json
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer

from python.recognition import MAX_FILE_BYTES, RecognitionError, recognize


MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024


def read_upload(content_type: str, body: bytes) -> tuple[str, str, bytes, int]:
    if not content_type.lower().startswith("multipart/form-data;"):
        raise RecognitionError(415, "Отправьте файл через форму multipart/form-data.")
    message = BytesParser(policy=default).parsebytes(
        b"Content-Type: " + content_type.encode("ascii", errors="ignore") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    if not message.is_multipart():
        raise RecognitionError(400, "Не удалось прочитать загруженный файл.")

    uploaded = None
    selected_page = None
    for part in message.iter_parts():
        if part.get_content_disposition() != "form-data":
            continue
        name = part.get_param("name", header="content-disposition")
        if name == "file":
            if uploaded is not None:
                raise RecognitionError(400, "Отправьте только один файл.")
            uploaded = (part.get_filename(), part.get_content_type(), part.get_payload(decode=True))
        elif name == "page_number":
            if selected_page is not None:
                raise RecognitionError(400, "Укажите только один номер страницы.")
            selected_page = part.get_payload(decode=True)

    if uploaded is None or not uploaded[0] or uploaded[2] is None:
        raise RecognitionError(400, "Файл не выбран.")
    if selected_page is None:
        raise RecognitionError(400, "Укажите номер страницы.")
    try:
        page_number = int(selected_page.decode("ascii"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise RecognitionError(400, "Номер страницы должен быть положительным целым числом.") from exc
    return uploaded[0], uploaded[1], uploaded[2], page_number


class handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        try:
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError as exc:
                raise RecognitionError(411, "Не указан размер запроса.") from exc
            if length < 0:
                raise RecognitionError(400, "Неверный размер запроса.")
            if length > MAX_REQUEST_BYTES:
                raise RecognitionError(413, "Файл больше 3 МБ. Выберите файл меньшего размера.")
            body = self.rfile.read(length)
            if len(body) != length:
                raise RecognitionError(400, "Загрузка файла прервалась.")
            filename, mime_type, data, page_number = read_upload(self.headers.get("Content-Type", ""), body)
            self._json(200, recognize(filename, mime_type, data, page_number))
        except RecognitionError as exc:
            self._json(exc.status, {"error": exc.message})
        except Exception:
            self._json(500, {"error": "Внутренняя ошибка сервера. Попробуйте позже."})

    def do_GET(self) -> None:
        self._json(405, {"error": "Используйте POST для распознавания страницы."})

    def log_message(self, format: str, *args: object) -> None:
        # Do not log uploaded filenames, content or provider diagnostics.
        return


if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv()
    HTTPServer(("127.0.0.1", 8000), handler).serve_forever()
