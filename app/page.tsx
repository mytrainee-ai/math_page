"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import RecognitionResult, { isRecognitionResponse, type RecognitionResponse } from "./recognition-result";

const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const TEST_FILE_URL = "/demo/page_005.jpg";
const TEST_FILE_NAME = "page_005.jpg";

type Source = {
  file: File;
  kind: "image" | "pdf";
  previewUrl?: string;
};

function fileError(file: File): string | null {
  if (file.size === 0) return "Файл пустой. Выберите другой файл.";
  if (file.size > MAX_FILE_BYTES) return "Файл больше 3 МБ. Выберите файл меньшего размера.";

  const extension = file.name.split(".").pop()?.toLowerCase();
  const allowedTypes: Record<string, string[]> = {
    jpg: ["image/jpeg"],
    jpeg: ["image/jpeg"],
    png: ["image/png"],
    pdf: ["application/pdf"],
  };
  if (!extension || !allowedTypes[extension]?.includes(file.type)) {
    return "Поддерживаются только JPG, PNG и PDF с правильным типом файла.";
  }
  return null;
}

function checkImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve();
      else reject(new Error("Изображение повреждено или пустое."));
    };
    image.onerror = () => reject(new Error("Изображение повреждено или не читается."));
    image.src = url;
  });
}

export default function Home() {
  const [source, setSource] = useState<Source | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [recognizing, setRecognizing] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [responseData, setResponseData] = useState<RecognitionResponse | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const pdfTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const imageUrlRef = useRef<string | null>(null);
  const selectionRef = useRef(0);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      selectionRef.current += 1;
      abortRef.current?.abort();
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      void pdfTaskRef.current?.destroy();
    };
  }, []);

  useEffect(() => {
    if (source?.kind !== "pdf" || !pdfRef.current || !canvasRef.current) return;

    const document = pdfRef.current;
    const canvas = canvasRef.current;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    const context = canvas.getContext("2d");
    if (!context) {
      setError("Браузер не может показать страницу PDF.");
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);

    async function renderPage() {
      try {
        const page = await document.getPage(pageNumber);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = canvas.parentElement?.clientWidth ?? 720;
        const displayScale = Math.min(1.5, availableWidth / baseViewport.width);
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: displayScale * pixelRatio });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`;
        canvas.style.height = "auto";
        renderTask = page.render({ canvas, canvasContext: context!, viewport });
        await renderTask.promise;
      } catch (cause) {
        if (!cancelled && !(cause instanceof Error && cause.name === "RenderingCancelledException")) {
          setError("Не удалось показать выбранную страницу PDF.");
        }
      }
    }

    void renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [source, pageNumber]);

  function resetSelectedFile() {
    const selection = ++selectionRef.current;
    requestRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setRecognizing(false);
    setRequestError("");
    setResponseData(null);
    setSource(null);
    setPageCount(0);
    setPageNumber(1);
    setError("");
    setLoading(false);
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = null;
    if (pdfTaskRef.current) void pdfTaskRef.current.destroy();
    pdfRef.current = null;
    pdfTaskRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = "";
    return selection;
  }

  async function loadFile(file: File, selection: number, clearInput?: () => void) {
    if (selection !== selectionRef.current) return;
    const validationError = fileError(file);
    if (validationError) {
      setError(validationError);
      clearInput?.();
      return;
    }

    setLoading(true);
    try {
      if (file.type === "application/pdf") {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const task = pdfjs.getDocument({ data: bytes });
        const pdf = await task.promise;
        if (selection !== selectionRef.current) {
          await task.destroy();
          return;
        }
        if (pdf.numPages === 0 || pdf.numPages > MAX_PDF_PAGES) {
          await task.destroy();
          throw new Error(`PDF должен содержать от 1 до ${MAX_PDF_PAGES} страниц.`);
        }
        pdfTaskRef.current = task;
        pdfRef.current = pdf;
        setPageCount(pdf.numPages);
        setSource({ file, kind: "pdf" });
      } else {
        const url = URL.createObjectURL(file);
        try {
          await checkImage(url);
        } catch (cause) {
          URL.revokeObjectURL(url);
          throw cause;
        }
        if (selection !== selectionRef.current) {
          URL.revokeObjectURL(url);
          return;
        }
        imageUrlRef.current = url;
        setSource({ file, kind: "image", previewUrl: url });
      }
    } catch (cause) {
      if (selection !== selectionRef.current) return;
      const message = cause instanceof Error ? cause.message : "Не удалось открыть файл.";
      setError(
        /password/i.test(message)
          ? "PDF защищён паролем. Выберите файл без защиты."
          : /PDF должен содержать/.test(message) || /Изображение/.test(message)
            ? message
            : "Файл повреждён или не читается. Выберите другой файл.",
      );
      clearInput?.();
    } finally {
      if (selection === selectionRef.current) setLoading(false);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    const selection = resetSelectedFile();
    if (file) await loadFile(file, selection, () => { input.value = ""; });
  }

  async function handleTestFile() {
    const selection = resetSelectedFile();
    setLoading(true);
    try {
      const response = await fetch(TEST_FILE_URL);
      if (!response.ok) throw new Error("Тестовый файл недоступен.");
      const blob = await response.blob();
      const file = new File([blob], TEST_FILE_NAME, { type: "image/jpeg" });
      if (selection !== selectionRef.current) return;
      await loadFile(file, selection);
    } catch {
      if (selection === selectionRef.current) {
        setError("Не удалось загрузить встроенную тестовую страницу. Попробуйте выбрать файл вручную.");
      }
    } finally {
      if (selection === selectionRef.current) setLoading(false);
    }
  }

  async function handleRecognize() {
    if (!source || loading || abortRef.current) return;
    const request = ++requestRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setRecognizing(true);
    setRequestError("");
    setResponseData(null);
    const form = new FormData();
    form.append("file", source.file);
    form.append("page_number", String(pageNumber));

    try {
      const response = await fetch("/api/recognize", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new Error(response.status === 413
          ? "Файл больше 3 МБ. Выберите файл меньшего размера."
          : "Сервер вернул неожиданный ответ. Попробуйте позже.");
      }
      if (request !== requestRef.current) return;
      if (!response.ok) {
        const message = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
          ? data.error
          : "Не удалось распознать страницу. Попробуйте позже.";
        throw new Error(message);
      }
      if (!isRecognitionResponse(data)) {
        throw new Error("Сервер вернул неполный результат распознавания.");
      }
      setResponseData(data);
    } catch (cause) {
      if (request !== requestRef.current || controller.signal.aborted) return;
      setRequestError(cause instanceof TypeError
        ? "Сетевая ошибка. Попробуйте позже."
        : cause instanceof Error ? cause.message : "Не удалось выполнить запрос. Попробуйте позже.");
    } finally {
      if (request === requestRef.current) {
        abortRef.current = null;
        setRecognizing(false);
      }
    }
  }

  return (
    <main className="page-shell">
      <header className="hero">
        <p className="eyebrow">Math Page Vision Lab</p>
        <h1>Распознавание страницы учебника</h1>
        <p className="lead">Выберите изображение или одну страницу PDF, чтобы подготовить её к распознаванию.</p>
      </header>

      <section className="panel" aria-labelledby="upload-title">
        <div className="section-heading">
          <span className="step">01</span>
          <div>
            <h2 id="upload-title">Выберите файл</h2>
            <p>JPG, PNG или PDF · до 3 МБ · для PDF не более 100 страниц</p>
          </div>
        </div>
        <div className="upload-actions">
          <label className="file-picker">
            <span>{source ? "Выбрать другой файл" : "Выбрать файл"}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
              onChange={handleFileChange}
              disabled={loading}
              aria-label="Выбрать изображение или PDF"
            />
          </label>
          <button
            type="button"
            className="test-button"
            onClick={handleTestFile}
            disabled={loading}
            aria-label="Загрузить тестовую страницу"
          >
            Тест
          </button>
        </div>
        {loading && <p className="status" role="status">Проверяем файл…</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      {source && (
        <section className="panel preview-panel" aria-labelledby="preview-title">
          <div className="section-heading">
            <span className="step">02</span>
            <div>
              <h2 id="preview-title">Предпросмотр страницы</h2>
              <p className="filename">{source.file.name}</p>
            </div>
          </div>
          {source.kind === "pdf" && (
            <div className="page-picker">
              <label htmlFor="page-number">Страница PDF</label>
              <select
                id="page-number"
                value={pageNumber}
                onChange={(event) => {
                  requestRef.current += 1;
                  abortRef.current?.abort();
                  abortRef.current = null;
                  setRecognizing(false);
                  setRequestError("");
                  setResponseData(null);
                  setError("");
                  setPageNumber(Number(event.target.value));
                }}
              >
                {Array.from({ length: pageCount }, (_, index) => (
                  <option key={index + 1} value={index + 1}>{index + 1}</option>
                ))}
              </select>
              <span>из {pageCount}</span>
            </div>
          )}
          <div className="preview-frame">
            {source.kind === "pdf" ? (
              <canvas ref={canvasRef} aria-label={`Предпросмотр страницы ${pageNumber} PDF`} role="img" />
            ) : (
              // Object URLs come from the validated local file and never leave this browser.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={source.previewUrl} alt={`Предпросмотр файла ${source.file.name}`} />
            )}
          </div>
          <div className="recognize-action">
            <p>Выбранная страница будет отправлена в OpenAI. Запрос может тарифицироваться провайдером.</p>
            <button type="button" onClick={handleRecognize} disabled={recognizing || loading}>
              {recognizing ? "Распознаём страницу…" : "Распознать страницу"}
            </button>
            {recognizing && <p role="status">Запрос выполняется. Это может занять некоторое время.</p>}
            {requestError && <p className="error" role="alert">{requestError}</p>}
          </div>
        </section>
      )}
      {source && responseData && <RecognitionResult data={responseData} />}
    </main>
  );
}
