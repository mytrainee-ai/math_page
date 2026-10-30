"""Build a Markdown document from a validated PageResult without another API call."""

from python.schema import PageElement, PageResult


TYPE_LABELS = {
    "definition": "Определение",
    "theorem": "Теорема",
    "rule": "Правило",
    "example": "Пример",
    "problem": "Задача",
    "solution": "Решение",
    "answer": "Ответ",
    "figure": "Рисунок",
    "other": "Фрагмент",
}


def _table_cell(value: str) -> str:
    return value.replace("|", r"\|").replace("\r\n", "<br>").replace("\n", "<br>")


def _table(element: PageElement) -> list[str]:
    assert element.rows is not None
    width = len(element.rows[0])
    header = element.rows[0] if element.has_header else [""] * width
    body = element.rows[1:] if element.has_header else element.rows
    lines = [
        "| " + " | ".join(_table_cell(cell) for cell in header) + " |",
        "| " + " | ".join("---" for _ in range(width)) + " |",
    ]
    lines.extend("| " + " | ".join(_table_cell(cell) for cell in row) + " |" for row in body)
    return lines


def render_markdown(result: PageResult) -> str:
    document = result.document
    safe_title = document.filename.replace("#", r"\#").replace("\n", " ")
    lines = [f"# {safe_title}", "", f"Страница: {document.page_number} · Язык: {document.language}", ""]

    for element in result.elements:
        if element.type == "heading" and element.text:
            lines.extend([f"## {element.text}", ""])
            continue

        if element.type == "table":
            if element.text:
                lines.extend([element.text, ""])
            lines.extend(_table(element))
            lines.append("")
            continue

        label = TYPE_LABELS.get(element.type)
        if element.text:
            lines.append(f"**{label}.** {element.text}" if label else element.text)
            lines.append("")
        elif label and element.description:
            lines.extend([f"**{label}.**", ""])

        if element.latex:
            if element.type == "formula":
                lines.extend(["$$", element.latex, "$$", ""])
            else:
                lines.extend([f"${element.latex}$", ""])
        if element.description:
            lines.extend([f"_{element.description}_", ""])

    return "\n".join(lines).rstrip() + "\n"
