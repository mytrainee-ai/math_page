"""Validate a file, render one page, and make one OpenAI Responses request."""

import base64
from io import BytesIO
import math
import os
from pathlib import PurePath

import pymupdf
from PIL import Image, ImageOps, UnidentifiedImageError
from openai import OpenAI
from openai import APIConnectionError, APIStatusError, APITimeoutError, AuthenticationError
from openai import BadRequestError, NotFoundError, RateLimitError
from pydantic import ValidationError

from python.schema import PageResult


MAX_FILE_BYTES = 3 * 1024 * 1024
MAX_PDF_PAGES = 100
MAX_RENDER_SIDE = 2560
MAX_RENDER_PIXELS = 6_000_000
MAX_IMAGE_PIXELS = 20_000_000
MAX_JPEG_BYTES = 2 * 1024 * 1024

Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


class RecognitionError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _jpeg(image: Image.Image) -> bytes:
    image = ImageOps.exif_transpose(image)
    if image.mode != "RGB":
        if "A" in image.getbands():
            background = Image.new("RGBA", image.size, "white")
            background.alpha_composite(image.convert("RGBA"))
            image = background.convert("RGB")
        else:
            image = image.convert("RGB")

    ratio = min(1, MAX_RENDER_SIDE / max(image.size), math.sqrt(MAX_RENDER_PIXELS / (image.width * image.height)))
    if ratio < 1:
        image = image.resize((max(1, round(image.width * ratio)), max(1, round(image.height * ratio))))

    for reduction in (1, 0.85, 0.7):
        if reduction < 1:
            image = image.resize((max(1, round(image.width * reduction)), max(1, round(image.height * reduction))))
        for quality in (90, 85, 80):
            output = BytesIO()
            image.save(output, format="JPEG", quality=quality, optimize=True)
            if output.tell() <= MAX_JPEG_BYTES:
                return output.getvalue()
    raise RecognitionError(422, "Не удалось подготовить изображение страницы. Выберите файл с меньшим разрешением.")


def _render_pdf(data: bytes, page_number: int) -> bytes:
    try:
        document = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise RecognitionError(422, "PDF повреждён или не читается.") from exc
    try:
        if document.needs_pass:
            raise RecognitionError(422, "PDF защищён паролем. Выберите файл без защиты.")
        if not 1 <= document.page_count <= MAX_PDF_PAGES:
            raise RecognitionError(422, f"PDF должен содержать от 1 до {MAX_PDF_PAGES} страниц.")
        if page_number < 1 or page_number > document.page_count:
            raise RecognitionError(422, "Выбранной страницы нет в PDF.")

        page = document.load_page(page_number - 1)
        page_width, page_height = page.rect.width, page.rect.height
        if page_width <= 0 or page_height <= 0:
            raise RecognitionError(422, "Выбранная страница PDF пуста или повреждена.")
        scale = min(
            200 / 72,
            MAX_RENDER_SIDE / max(page_width, page_height),
            math.sqrt(MAX_RENDER_PIXELS / (page_width * page_height)),
        )
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csRGB, alpha=False)
        image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
        return _jpeg(image)
    except RecognitionError:
        raise
    except Exception as exc:
        raise RecognitionError(422, "Не удалось преобразовать выбранную страницу PDF.") from exc
    finally:
        document.close()


def _render_image(data: bytes, expected_format: str) -> bytes:
    try:
        with Image.open(BytesIO(data)) as image:
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise RecognitionError(422, "Изображение имеет слишком большое разрешение.")
            image.load()
            if image.format != expected_format:
                raise RecognitionError(415, "Содержимое изображения не соответствует его формату.")
            return _jpeg(image)
    except RecognitionError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise RecognitionError(422, "Изображение повреждено или не читается.") from exc


def recognize(filename: str, mime_type: str, data: bytes, page_number: int) -> dict:
    if not data:
        raise RecognitionError(400, "Файл пустой.")
    if len(data) > MAX_FILE_BYTES:
        raise RecognitionError(413, "Файл больше 3 МБ. Выберите файл меньшего размера.")

    safe_filename = PurePath(filename.replace("\\", "/")).name
    extension = safe_filename.rsplit(".", 1)[-1].lower() if "." in safe_filename else ""
    allowed = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "pdf": "application/pdf"}
    if allowed.get(extension) != mime_type:
        raise RecognitionError(415, "Поддерживаются только JPG, PNG и PDF с правильным типом файла.")
    if not isinstance(page_number, int) or page_number < 1:
        raise RecognitionError(400, "Номер страницы должен быть положительным целым числом.")
    if extension != "pdf" and page_number != 1:
        raise RecognitionError(400, "Для изображения доступна только первая страница.")

    image_bytes = _render_pdf(data, page_number) if extension == "pdf" else _render_image(
        data, "PNG" if extension == "png" else "JPEG"
    )
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise RecognitionError(503, "Ключ OpenAI не настроен на сервере. Укажите OPENAI_API_KEY.")
    model = os.getenv("OPENAI_MODEL") or "gpt-6-luna"
    base_url = os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1"

    prompt = (
        "Распознай только видимое содержимое одной страницы математического учебника. "
        "Сохраняй исходный язык и порядок чтения. Не решай задачи, не добавляй и не исправляй содержание. "
        "Сомнительные фрагменты отмечай словом [неразборчиво]. "
        "Формулы записывай в LaTeX без знаков $. Таблицы представляй как массив строк rows: "
        "каждая строка содержит текстовые ячейки; has_header показывает наличие заголовка. "
        "Для элементов вне таблицы rows и has_header должны быть null. "
        "Дай непустой список элементов с уникальными id element_001, element_002 и последовательным order от 1."
    )

    try:
        client = OpenAI(api_key=key, base_url=base_url, timeout=60, max_retries=0)
        response = client.responses.parse(
            model=model,
            input=[{
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {"type": "input_image", "image_url": f"data:image/jpeg;base64,{base64.b64encode(image_bytes).decode('ascii')}", "detail": "high"},
                ],
            }],
            text_format=PageResult,
            max_output_tokens=12000,
            store=False,
        )
    except AuthenticationError as exc:
        raise RecognitionError(502, "Ошибка авторизации OpenAI. Проверьте серверный ключ API.") from exc
    except RateLimitError as exc:
        raise RecognitionError(429, "Достигнут лимит запросов OpenAI. Попробуйте позже.") from exc
    except NotFoundError as exc:
        raise RecognitionError(502, "Указанная модель OpenAI недоступна. Проверьте OPENAI_MODEL.") from exc
    except BadRequestError as exc:
        raise RecognitionError(502, "OpenAI отклонил запрос. Проверьте модель и совместимость API.") from exc
    except (APIConnectionError, APITimeoutError) as exc:
        raise RecognitionError(502, "Не удалось связаться с OpenAI. Попробуйте позже.") from exc
    except APIStatusError as exc:
        raise RecognitionError(502, "OpenAI временно недоступен. Попробуйте позже.") from exc
    except (ValidationError, ValueError) as exc:
        raise RecognitionError(502, "Ответ модели не прошёл проверку структуры.") from exc

    result = response.output_parsed
    if result is None:
        raise RecognitionError(502, "Модель не вернула структурированный результат.")
    # The server owns source metadata; model guesses must never replace it.
    result.document.filename = safe_filename
    result.document.page_number = page_number
    usage = response.usage
    return {
        "result": result.model_dump(),
        "model": model,
        "usage": {
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "total_tokens": usage.total_tokens,
        } if usage else None,
    }
