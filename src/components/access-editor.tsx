"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { accessSchema, roleCodes, type UserIdentity } from "@/lib/identity";
import {
  type Department,
  roleNames,
  statusNames,
} from "@/lib/identity-display";
import { api, errorMessage, handleSessionError } from "@/lib/api-client";
import { Field, Notice } from "./ui";
import type { z } from "zod";

export function AccessEditor({
  user,
  departments,
  onCancel,
  onSaved,
}: {
  user: UserIdentity;
  departments: Department[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [review, setReview] = useState<z.infer<typeof accessSchema> | null>(
    null,
  );
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<z.infer<typeof accessSchema> | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [review]);
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const parsed = accessSchema.safeParse({
      departmentId: values.get("departmentId"),
      status: values.get("status"),
      roles: ["employee", ...values.getAll("roles")],
      reason: values.get("reason"),
    });
    if (!parsed.success) {
      setError("请选择有效部门和状态，并填写 1–500 字的变更原因。");
      return;
    }
    setError("");
    setReview(parsed.data);
    setDraft(parsed.data);
  }
  async function save() {
    if (!review || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/admin/users/${user.id}/access`, {
        method: "PATCH",
        body: JSON.stringify(review),
      });
      onSaved();
    } catch (error) {
      if (!handleSessionError(error)) setError(errorMessage(error));
      setBusy(false);
    }
  }
  const name = (id: string | null) =>
    departments.find((d) => d.id === id)?.name ?? "尚未确认";
  return (
    <section className="panel editor" aria-labelledby="editor-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{review ? "提交前确认" : "部门与权限"}</p>
          <h2 id="editor-heading" ref={heading} tabIndex={-1}>
            {user.fullName} <span className="muted">@{user.username}</span>
          </h2>
        </div>
        <button className="button secondary" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
      {error && <Notice error>{error}</Notice>}
      {review ? (
        <div className="stack">
          <dl className="detail-list">
            <div>
              <dt>确认部门</dt>
              <dd>
                {name(user.departmentId)} → {name(review.departmentId)}
              </dd>
            </div>
            <div>
              <dt>账号状态</dt>
              <dd>
                {statusNames[user.status]} → {statusNames[review.status]}
              </dd>
            </div>
            <div>
              <dt>原角色</dt>
              <dd>{user.roles.map((role) => roleNames[role]).join("、")}</dd>
            </div>
            <div>
              <dt>调整后角色</dt>
              <dd>{review.roles.map((role) => roleNames[role]).join("、")}</dd>
            </div>
            <div>
              <dt>变更原因</dt>
              <dd>{review.reason}</dd>
            </div>
          </dl>
          <Notice>
            {review.status === "disabled"
              ? "保存后该用户将无法登录。"
              : "保存后该用户需要重新登录。"}
            此操作会撤销该用户所有现有会话，并记录操作审计。
          </Notice>
          <div className="actions">
            <button
              className={`button ${review.status === "disabled" ? "danger" : ""}`}
              onClick={save}
              disabled={busy}
            >
              {busy ? "保存中…" : "确认保存"}
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setReview(null);
                setError("");
              }}
            >
              返回修改
            </button>
          </div>
        </div>
      ) : (
        <form method="post" className="stack" onSubmit={prepare} noValidate>
          <div className="form-grid">
            <Field label="确认部门" name="departmentId">
              <select
                id="departmentId"
                name="departmentId"
                defaultValue={
                  draft?.departmentId ??
                  user.departmentId ??
                  user.requestedDepartmentId
                }
                required
              >
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="账号状态" name="status">
              <select
                id="status"
                name="status"
                defaultValue={
                  draft?.status ??
                  (user.status === "disabled" ? "disabled" : "active")
                }
              >
                <option value="active">已启用</option>
                <option value="disabled">已停用</option>
              </select>
            </Field>
          </div>
          <fieldset>
            <legend>授予角色</legend>
            <p className="hint">
              系统管理员负责账号配置，不会自动取得业务审批权限。
            </p>
            <div className="role-options">
              {roleCodes.map((role) => (
                <label key={role}>
                  <input
                    type="checkbox"
                    name="roles"
                    value={role}
                    defaultChecked={(draft?.roles ?? user.roles).includes(role)}
                    disabled={role === "employee"}
                  />
                  {roleNames[role]}
                  {role === "employee" && <small>（基础角色）</small>}
                </label>
              ))}
            </div>
          </fieldset>
          <Field
            label="变更原因"
            name="reason"
            hint="请说明确认或调整依据，此内容会保留在审计记录中。"
          >
            <textarea
              id="reason"
              name="reason"
              rows={3}
              maxLength={500}
              defaultValue={draft?.reason ?? ""}
              required
            />
          </Field>
          <div>
            <button className="button">检查变更</button>
          </div>
        </form>
      )}
    </section>
  );
}
