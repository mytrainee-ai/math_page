"use client";

import { useState } from "react";

type PageElement = {
  id: string;
  order: number;
  type: string;
  text: string | null;
  latex: string | null;
  description: string | null;
  rows: string[][] | null;
  has_header: boolean | null;
};

export type RecognitionResponse = {
  result: {
    document: { filename: string; page_number: number; language: string };
    elements: PageElement[];
  };
  markdown: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
};

export function isRecognitionResponse(value: unknown): value is RecognitionResponse {
  if (typeof value !== "object" || value === null || !("result" in value) || !("markdown" in value)) return false;
  const result = value.result;
  if (typeof value.markdown !== "string" || typeof result !== "object" || result === null) return false;
  return "document" in result && "elements" in result && Array.isArray(result.elements);
}

const labels: Record<string, string> = {
  heading: "Заголовок", paragraph: "Текст", definition: "Определение", theorem: "Теорема",
  rule: "Правило", formula: "Формула", example: "Пример", problem: "Задача",
  solution: "Решение", answer: "Ответ", table: "Таблица", figure: "Рисунок", other: "Фрагмент",
};

type Tab = "result" | "markdown" | "json";

function safeStem(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "page";
}

export default function RecognitionResult({ data }: { data: RecognitionResponse }) {
  const [tab, setTab] = useState<Tab>("result");
  const { document, elements } = data.result;
  const json = JSON.stringify(data.result, null, 2) + "\n";

  function download(kind: "markdown" | "json") {
    const content = kind === "markdown" ? data.markdown : json;
    const mime = kind === "markdown" ? "text/markdown" : "application/json";
    const extension = kind === "markdown" ? "md" : "json";
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeStem(document.filename)}-page-${document.page_number}.${extension}`;
    window.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="panel result-panel" aria-labelledby="result-title">
      <div className="section-heading">
        <span className="step">03</span>
        <div>
          <h2 id="result-title">Результат распознавания</h2>
          <p>{document.filename} · страница {document.page_number} · язык {document.language === "ru" ? "Русский" : document.language}</p>
        </div>
      </div>

      <div className="result-tools">
        <div className="result-tabs" role="tablist" aria-label="Формат результата">
          {(["result", "markdown", "json"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              aria-controls="result-content"
              onClick={() => setTab(item)}
            >
              {item === "result" ? "Результат" : item === "markdown" ? "Markdown" : "JSON"}
            </button>
          ))}
        </div>
        <div className="download-actions">
          <button type="button" onClick={() => download("markdown")}>Скачать .md</button>
          <button type="button" onClick={() => download("json")}>Скачать .json</button>
        </div>
      </div>

      <div id="result-content" role="tabpanel" className="result-content">
        {tab === "result" && (
          <div className="element-list">
            {elements.map((element) => (
              <article className="element" key={element.id}>
                <div className="element-meta">
                  <span>{labels[element.type] ?? "Фрагмент"}</span>
                  <span>#{element.order}</span>
                </div>
                {element.text && <p className="element-text">{element.text}</p>}
                {element.latex && <div className="latex-block"><span>LaTeX</span><code>{element.latex}</code></div>}
                {element.rows && (
                  <div className="table-scroll">
                    <table>
                      {element.has_header && <thead><tr>{element.rows[0].map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>}
                      <tbody>
                        {(element.has_header ? element.rows.slice(1) : element.rows).map((row, rowIndex) => (
                          <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {element.description && <p className="element-description">{element.description}</p>}
              </article>
            ))}
          </div>
        )}
        {tab === "markdown" && <pre className="code-view">{data.markdown}</pre>}
        {tab === "json" && <pre className="code-view">{json}</pre>}
      </div>

      {data.usage && (
        <p className="usage">
          Токены: вход {data.usage.input_tokens}, выход {data.usage.output_tokens}, всего {data.usage.total_tokens}. Модель: {data.model}.
        </p>
      )}
    </section>
  );
}
