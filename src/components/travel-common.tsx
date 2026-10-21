"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Attachment } from "@/lib/attachments";
import {
  RequestError,
  errorMessage,
  handleSessionError,
} from "@/lib/api-client";
import { fileSize, travelTime } from "@/lib/travel-display";
import { Notice } from "./ui";
import { PdfPreview } from "./pdf-preview";

export function TravelDialog({
  title,
  children,
  close,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="travel-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="section-heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={close}
        >
          关闭
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function TravelFailure({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <div className="stack">
      <Notice error>{message}</Notice>
      <div>
        <button className="button secondary" onClick={retry}>
          重新加载
        </button>
      </div>
    </div>
  );
}
export function AttachmentItems({
  appId,
  resource = "travel-applications",
  items,
  onDelete,
  disabled = false,
}: {
  appId: string;
  resource?:
    "travel-applications" | "purchase-drafts" | "purchase-applications";
  items: Attachment[];
  onDelete?: (file: Attachment) => void;
  disabled?: boolean;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    file: Attachment;
    url: string;
  } | null>(null);
  const locked = useRef(false);
  useEffect(() => {
    if (preview) return () => URL.revokeObjectURL(preview.url);
  }, [preview]);
  async function open(file: Attachment, download: boolean) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      let response: Response;
      try {
        response = await fetch(
          `/api/${resource}/${appId}/attachments/${file.id}/content`,
          {
            credentials: "same-origin",
            cache: "no-store",
            signal: AbortSignal.timeout(30000),
          },
        );
      } catch {
        throw new RequestError(0, "附件读取失败，请检查网络后重试。");
      }
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new RequestError(
          response.status,
          result?.error?.message ?? "附件无法读取",
          result?.error?.code,
        );
      }
      const url = URL.createObjectURL(await response.blob());
      if (download) {
        const link = document.createElement("a");
        link.href = url;
        link.download = file.originalName;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else setPreview({ file, url });
    } catch (error) {
      if (!handleSessionError(error)) setError(errorMessage(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      {error && <Notice error>{error}</Notice>}
      {busy && (
        <p role="status" className="hint">
          正在读取附件…
        </p>
      )}
      {!items.length && <p className="hint">暂无附件</p>}
      <ul className="attachment-list">
        {items.map((file) => (
          <li key={file.id}>
            <div>
              <strong>{file.originalName}</strong>
              <small>
                {fileSize(file.sizeBytes)} · {file.mimeType} ·{" "}
                {travelTime(file.createdAt)}
              </small>
            </div>
            <div className="actions">
              <button
                type="button"
                className="button secondary compact"
                disabled={disabled || busy}
                aria-label={`预览 ${file.originalName}`}
                onClick={() => void open(file, false)}
              >
                预览
              </button>
              <button
                type="button"
                className="button secondary compact"
                disabled={disabled || busy}
                aria-label={`下载 ${file.originalName}`}
                onClick={() => void open(file, true)}
              >
                下载
              </button>
              {onDelete && (
                <button
                  type="button"
                  className="text-button"
                  disabled={disabled || busy}
                  aria-label={`删除 ${file.originalName}`}
                  onClick={() => onDelete(file)}
                >
                  删除
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {preview && (
        <TravelDialog
          title={`预览：${preview.file.originalName}`}
          close={() => setPreview(null)}
        >
          {preview.file.mimeType === "application/pdf" ? (
            <PdfPreview url={preview.url} />
          ) : (
            // Original authenticated image; temporary object URL is revoked on close/unmount.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="attachment-preview"
              src={preview.url}
              alt={preview.file.originalName}
            />
          )}
        </TravelDialog>
      )}
    </>
  );
}
