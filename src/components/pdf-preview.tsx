"use client";
import { useEffect, useRef, useState } from "react";
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  RenderTask,
} from "pdfjs-dist";
import { Notice } from "./ui";

export function PdfPreview({ url }: { url: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    const controller = new AbortController();
    async function load() {
      try {
        const lib = await import("pdfjs-dist");
        const resources = `/vendor/pdfjs/${lib.version}/`;
        lib.GlobalWorkerOptions.workerSrc = `${resources}pdf.worker.min.mjs`;
        const data = new Uint8Array(
          await (await fetch(url, { signal: controller.signal })).arrayBuffer(),
        );
        if (!active) return;
        task = lib.getDocument({
          data,
          cMapUrl: `${resources}cmaps/`,
          standardFontDataUrl: `${resources}standard_fonts/`,
          wasmUrl: `${resources}wasm/`,
          iccUrl: `${resources}iccs/`,
          enableXfa: false,
          canvasMaxAreaInBytes: 16_000_000,
        });
        const document = await task.promise;
        if (active) setPdf(document);
      } catch {
        if (active) setError("PDF 预览失败，请关闭后重试或下载原件查看。");
      }
    }
    void load();
    return () => {
      active = false;
      controller.abort();
      void task?.destroy();
    };
  }, [url]);
  if (error) return <Notice error>{error}</Notice>;
  if (!pdf)
    return (
      <p role="status" className="empty-state">
        正在解析 PDF…
      </p>
    );
  return (
    <div className="stack pdf-viewer">
      <nav className="pager" aria-label="PDF 翻页">
        <span>
          第 {page} / {pdf.numPages} 页
        </span>
        <div className="actions">
          <button
            type="button"
            className="button secondary"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={page === pdf.numPages}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </div>
      </nav>
      <PdfPage key={page} pdf={pdf} pageNumber={page} />
    </div>
  );
}
function PdfPage({
  pdf,
  pageNumber,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    let active = true;
    let render: RenderTask | undefined;
    async function paint() {
      try {
        const page = await pdf.getPage(pageNumber);
        if (!active) return;
        const base = page.getViewport({ scale: 1 });
        // Limit raster dimensions regardless of the PDF's own page size.
        const viewport = page.getViewport({
          scale: Math.min(2, 1600 / Math.max(base.width, base.height)),
        });
        const element = canvas.current!;
        element.width = Math.ceil(viewport.width);
        element.height = Math.ceil(viewport.height);
        render = page.render({ canvas: element, viewport });
        await render.promise;
        if (active) setStatus("ready");
      } catch {
        if (active) setStatus("error");
      }
    }
    void paint();
    return () => {
      active = false;
      render?.cancel();
    };
  }, [pdf, pageNumber]);
  return (
    <>
      {status === "loading" && <p role="status">正在绘制第 {pageNumber} 页…</p>}
      {status === "error" && (
        <Notice error>此页无法预览，请下载原件查看。</Notice>
      )}
      <canvas
        ref={canvas}
        className="pdf-canvas"
        role="img"
        aria-label={`PDF 第 ${pageNumber} 页`}
        data-rendered={status === "ready"}
      />
    </>
  );
}
