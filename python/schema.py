"""Structured response and additional validation for one textbook page."""

from typing import Literal

from pydantic import BaseModel, model_validator


ElementType = Literal[
    "heading", "paragraph", "definition", "theorem", "rule", "formula",
    "example", "problem", "solution", "answer", "table", "figure", "other",
]


class DocumentInfo(BaseModel):
    filename: str
    page_number: int
    language: str


class PageElement(BaseModel):
    id: str
    order: int
    type: ElementType
    text: str | None
    latex: str | None
    description: str | None
    rows: list[list[str]] | None
    has_header: bool | None

    @model_validator(mode="after")
    def validate_table(self) -> "PageElement":
        if self.type == "table":
            if not self.rows or not self.rows[0]:
                raise ValueError("A table needs at least one nonempty row")
            width = len(self.rows[0])
            if any(len(row) != width for row in self.rows):
                raise ValueError("All table rows must have the same width")
            if self.has_header is None:
                raise ValueError("A table needs has_header")
        elif self.rows is not None or self.has_header is not None:
            raise ValueError("Only table elements may contain rows or has_header")
        return self


class PageResult(BaseModel):
    document: DocumentInfo
    elements: list[PageElement]

    @model_validator(mode="after")
    def validate_elements(self) -> "PageResult":
        if not self.elements:
            raise ValueError("The page must contain at least one element")
        ids = [element.id for element in self.elements]
        if len(ids) != len(set(ids)):
            raise ValueError("Element IDs must be unique")
        if [element.order for element in self.elements] != list(range(1, len(ids) + 1)):
            raise ValueError("Element order must start at 1 without gaps")
        return self
