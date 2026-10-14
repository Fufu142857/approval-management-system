import type { ReactNode } from "react";
import { statusNames } from "@/lib/identity-display";
import type { UserIdentity } from "@/lib/identity";
export function Field({
  label,
  name,
  hint,
  error,
  children,
}: {
  label: string;
  name: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      {children}
      {hint && (
        <p id={`${name}-hint`} className="hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${name}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`notice ${error ? "notice-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function StatusBadge({ status }: { status: UserIdentity["status"] }) {
  return <span className={`badge badge-${status}`}>{statusNames[status]}</span>;
}
export function Pager({
  page,
  pageSize,
  total,
  busy,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  busy: boolean;
  onChange: (page: number) => void;
}) {
  return (
    <nav className="pager" aria-label="列表分页">
      <span>
        共 {total} 条 · 第 {page} / {Math.max(1, Math.ceil(total / pageSize))}{" "}
        页
      </span>
      <div className="actions">
        <button
          className="button secondary"
          disabled={busy || page <= 1}
          onClick={() => onChange(page - 1)}
        >
          上一页
        </button>
        <button
          className="button secondary"
          disabled={busy || page * pageSize >= total}
          onClick={() => onChange(page + 1)}
        >
          下一页
        </button>
      </div>
    </nav>
  );
}
