"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  handleSessionError,
  RequestError,
} from "@/lib/api-client";
import {
  completeTravelSchema,
  travelDraftSchema,
  type TravelDraft,
} from "@/lib/travel";
import {
  maxAttachmentBytes,
  maxAttachments,
  maxApplicationAttachmentBytes,
  type Attachment,
} from "@/lib/attachments";
import {
  travelFields,
  fileSize,
  type TravelAttachmentList,
  type TravelDetail,
} from "@/lib/travel-display";
import { useResource } from "./use-resource";
import { Field, Notice } from "./ui";
import { AttachmentItems, TravelDialog, TravelFailure } from "./travel-common";

type Props = { applicant: string; department: string };
export function ExistingTravelEditor({ id, ...props }: Props & { id: string }) {
  const draft = useResource<TravelDraft>(`/travel-drafts/${id}`);
  const files = useResource<TravelAttachmentList>(
    `/travel-applications/${id}/attachments`,
  );
  const reload = () => {
    draft.reload();
    files.reload();
  };
  if (draft.error || files.error)
    return (
      <div className="stack">
        <TravelFailure message={draft.error || files.error!} retry={reload} />
        <Link className="text-button" href={`/travel/applications/${id}`}>
          查看已提交申请
        </Link>
        <Link href="/travel/drafts">返回草稿列表</Link>
      </div>
    );
  if (!draft.data || !files.data)
    return (
      <p role="status" className="empty-state">
        正在加载差旅草稿…
      </p>
    );
  if (draft.data.version !== files.data.version)
    return (
      <TravelFailure
        message="加载期间申请已变化，请重新加载。"
        retry={reload}
      />
    );
  return (
    <TravelEditor
      key={`${id}:${draft.data.version}`}
      {...props}
      initial={draft.data}
      initialFiles={files.data.items}
    />
  );
}
export function TravelEditor({
  applicant,
  department,
  initial,
  initialFiles = [],
}: Props & { initial?: TravelDraft; initialFiles?: Attachment[] }) {
  const [draft, setDraft] = useState(initial);
  const [form, setForm] = useState(() => travelFields(initial));
  const [files, setFiles] = useState(initialFiles);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [confirm, setConfirm] = useState<
    "submit" | "draft" | Attachment | null
  >(null);
  const locked = useRef(false);
  const leaving = useRef(false);
  const inputFile = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(travelFields(draft));
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!leaving.current && (dirty || busy)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const click = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest?.("a[href]");
      if (
        !anchor ||
        anchor.getAttribute("target") === "_blank" ||
        leaving.current ||
        (!dirty && !busy) ||
        anchor.getAttribute("href")?.startsWith("#")
      )
        return;
      if (busy || !window.confirm("有尚未保存的修改，确定离开吗？")) {
        event.preventDefault();
        event.stopPropagation();
      } else leaving.current = true;
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty, busy]);
  function validate(complete: boolean) {
    const raw = {
      ...form,
      startDate: form.startDate || null,
      endDate: form.endDate || null,
      budget: form.budget || null,
    };
    const parsed = (
      complete ? completeTravelSchema : travelDraftSchema
    ).safeParse(raw);
    if (!parsed.success) {
      const result: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const name = String(issue.path[0]);
        result[name] ??= !form[name as keyof typeof form]
          ? "请填写此项。"
          : issue.message;
      }
      setErrors(result);
      setError("请检查标出的字段后重试。");
      document.getElementById(Object.keys(result)[0])?.focus();
      return null;
    }
    setErrors({});
    return parsed.data;
  }
  async function save(complete = false) {
    const data = validate(complete);
    if (!data) return;
    if (draft && !dirty) return draft;
    const saved = await api<TravelDraft>(
      draft ? `/travel-drafts/${draft.id}` : "/travel-drafts",
      {
        method: draft ? "PUT" : "POST",
        body: JSON.stringify(
          draft ? { ...data, version: draft.version } : data,
        ),
      },
    );
    setDraft(saved);
    setForm(travelFields(saved));
    if (!draft)
      window.history.replaceState(null, "", `/travel/drafts/${saved.id}`);
    return saved;
  }
  async function run(work: () => Promise<void>) {
    if (locked.current || blocked) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (error) {
      if (!handleSessionError(error)) {
        setError(errorMessage(error));
        if (error instanceof RequestError) {
          if (error.fieldErrors)
            setErrors(
              Object.fromEntries(
                Object.entries(error.fieldErrors).map(([key, messages]) => [
                  key,
                  messages.join("；"),
                ]),
              ),
            );
          // Uncertain writes must be inspected, never automatically replayed.
          if (
            error.status === 0 ||
            error.status >= 500 ||
            ["VERSION_CONFLICT", "NOT_DRAFT", "VERSION_LIMIT"].includes(
              error.code ?? "",
            )
          )
            setBlocked(true);
        }
      }
    } finally {
      locked.current = false;
      setBusy(false);
      setConfirm(null);
    }
  }
  function checkSubmit() {
    setError("");
    setMessage("");
    if (validate(true)) setConfirm("submit");
  }
  async function confirmedAction() {
    await run(async () => {
      if (confirm === "submit") {
        const saved = await save(true);
        if (!saved) return;
        const result = await api<TravelDetail>(
          `/travel-drafts/${saved.id}/submit`,
          { method: "POST", body: JSON.stringify({ version: saved.version }) },
        );
        leaving.current = true;
        window.location.replace(
          `/travel/applications/${result.application.id}`,
        );
      } else if (confirm === "draft" && draft) {
        await api(`/travel-drafts/${draft.id}`, {
          method: "DELETE",
          body: JSON.stringify({ version: draft.version }),
        });
        leaving.current = true;
        window.location.replace("/travel/drafts");
      } else if (confirm && typeof confirm === "object" && draft) {
        const result = await api<{ version: number }>(
          `/travel-applications/${draft.id}/attachments/${confirm.id}`,
          {
            method: "DELETE",
            body: JSON.stringify({ version: draft.version }),
          },
        );
        setFiles(files.filter((file) => file.id !== confirm.id));
        setDraft({ ...draft, version: result.version });
        setMessage("附件已删除。");
      }
    });
  }
  async function upload(file: File) {
    if (!draft) return;
    await run(async () => {
      if (!file.size || file.size > maxAttachmentBytes) {
        setError("请选择非空且不超过 10 MiB 的附件。");
        return;
      }
      if (!/\.(jpe?g|png|pdf)$/i.test(file.name)) {
        setError("仅支持 JPEG、PNG、PDF 文件。");
        return;
      }
      if (
        files.length >= maxAttachments ||
        files.reduce((total, item) => total + item.sizeBytes, file.size) >
          maxApplicationAttachmentBytes
      ) {
        setError("每份申请最多 9 件附件，合计不超过 50 MiB。");
        return;
      }
      const body = new FormData();
      body.set("file", file);
      body.set("version", String(draft.version));
      const result = await api<{ attachment: Attachment; version: number }>(
        `/travel-applications/${draft.id}/attachments`,
        { method: "POST", body, signal: AbortSignal.timeout(60000) },
      );
      setFiles([...files, result.attachment]);
      setDraft({ ...draft, version: result.version });
      setMessage("附件已上传；表单中未保存的修改仍需保存。");
    });
  }
  const attributes = (name: keyof typeof form) => ({
    id: name,
    name,
    value: form[name],
    "aria-invalid": !!errors[name],
    "aria-describedby": errors[name] ? `${name}-error` : undefined,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setForm({ ...form, [name]: event.target.value }),
  });
  const dateCheck = travelDraftSchema.safeParse({
    startDate: form.startDate || null,
    endDate: form.endDate || null,
  });
  const days =
    dateCheck.success && form.startDate && form.endDate
      ? (Date.parse(`${form.endDate}T00:00:00Z`) -
          Date.parse(`${form.startDate}T00:00:00Z`)) /
          86400000 +
        1
      : null;
  return (
    <div className="stack travel-workspace">
      <div className="section-heading">
        <Link href="/travel/drafts" className="text-button">
          ← 返回草稿列表
        </Link>
        <span className="hint">
          {draft ? draft.appNo : "新建申请"} · 草稿
          {dirty ? " · 有未保存修改" : ""}
        </span>
      </div>
      <noscript>
        <Notice>请启用 JavaScript 后填写与保存差旅申请。</Notice>
      </noscript>
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {blocked && (
        <Notice error>
          <p>
            结果可能已变化。当前输入仍保留，请先查看服务器记录，确认后重新加载；不要重复提交。
          </p>
          <div className="actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => {
                if (window.confirm("重新加载会丢弃未保存修改，是否继续？")) {
                  leaving.current = true;
                  window.location.reload();
                }
              }}
            >
              丢弃本地修改并重新加载
            </button>
            <a
              className="text-button"
              target="_blank"
              rel="noreferrer"
              href={
                draft ? `/travel/applications/${draft.id}` : "/travel/drafts"
              }
            >
              新窗口查看服务器记录
            </a>
          </div>
        </Notice>
      )}
      <form
        method="post"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            if (await save()) setMessage("草稿已保存。");
          });
        }}
      >
        <fieldset disabled={busy || blocked} className="stack">
          <section className="panel travel-section">
            <h2>基本信息</h2>
            <div className="travel-basic-grid">
              <Field name="title" label="申请标题 *" error={errors.title}>
                <input
                  {...attributes("title")}
                  maxLength={200}
                  placeholder="请输入差旅申请标题"
                />
              </Field>
              <Field name="department" label="申请部门">
                <input id="department" value={department} readOnly />
              </Field>
              <Field name="applicant" label="申请人">
                <input id="applicant" value={applicant} readOnly />
              </Field>
            </div>
            <Field name="purpose" label="出差目的 *" error={errors.purpose}>
              <textarea
                {...attributes("purpose")}
                maxLength={2000}
                rows={3}
                placeholder="说明出差目的与工作安排"
              />
            </Field>
          </section>
          <section className="panel travel-section">
            <h2>行程安排</h2>
            <div className="form-grid">
              <Field
                name="departure"
                label="出发地点 *"
                error={errors.departure}
              >
                <input
                  {...attributes("departure")}
                  maxLength={200}
                  placeholder="如：杭州"
                />
              </Field>
              <Field
                name="destination"
                label="目的地 *"
                error={errors.destination}
              >
                <input
                  {...attributes("destination")}
                  maxLength={200}
                  placeholder="如：上海"
                />
              </Field>
              <Field
                name="startDate"
                label="开始日期 *"
                error={errors.startDate}
              >
                <input
                  {...attributes("startDate")}
                  type="date"
                  min="0001-01-01"
                  max="9999-12-31"
                />
              </Field>
              <Field name="endDate" label="结束日期 *" error={errors.endDate}>
                <input
                  {...attributes("endDate")}
                  type="date"
                  min="0001-01-01"
                  max="9999-12-31"
                />
              </Field>
              <Field
                name="transportation"
                label="交通方式 *"
                error={errors.transportation}
              >
                <input
                  {...attributes("transportation")}
                  maxLength={100}
                  placeholder="如：高铁、飞机"
                />
              </Field>
              <Field
                name="companions"
                label="同行人员"
                error={errors.companions}
              >
                <input
                  {...attributes("companions")}
                  maxLength={1000}
                  placeholder="填写同行人员姓名（选填）"
                />
              </Field>
            </div>
            <p className="hint" role="status">
              出差天数：{days === null ? "—" : `${days} 天`} ·
              按自然日计算，首尾日期均计入
            </p>
          </section>
          <section className="panel travel-section">
            <h2>费用预算与备注</h2>
            <div className="form-grid">
              <Field
                name="budget"
                label="费用预算（元）*"
                error={errors.budget}
              >
                <input
                  {...attributes("budget")}
                  inputMode="decimal"
                  maxLength={15}
                  placeholder="0.00"
                />
              </Field>
              <Field name="remarks" label="备注" error={errors.remarks}>
                <textarea
                  {...attributes("remarks")}
                  maxLength={2000}
                  rows={2}
                  placeholder="补充说明（选填）"
                />
              </Field>
            </div>
          </section>
          <section className="panel travel-section">
            <div className="section-heading">
              <h2>补充附件</h2>
              <span className="hint">
                {files.length}/9 件 ·{" "}
                {fileSize(files.reduce((sum, f) => sum + f.sizeBytes, 0))}/50
                MiB
              </span>
            </div>
            <div
              className="upload-zone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (!busy && !blocked && draft) {
                  if (event.dataTransfer.files.length !== 1)
                    setError("请每次上传一个附件。");
                  else void upload(event.dataTransfer.files[0]);
                }
              }}
            >
              <button
                type="button"
                className="text-button"
                disabled={!draft || busy}
                onClick={() => inputFile.current?.click()}
              >
                ↑ 点击上传 或拖拽文件到此处
              </button>
              <input
                ref={inputFile}
                type="file"
                aria-label="选择补充附件"
                accept=".jpg,.jpeg,.png,.pdf"
                hidden
                disabled={!draft || busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void upload(file);
                }}
              />
              <p className="hint">支持 JPEG、PNG、PDF，单件不超过 10 MiB</p>
              {!draft && <p className="hint">先保存草稿，再添加附件。</p>}
            </div>
            {draft && (
              <AttachmentItems
                appId={draft.id}
                items={files}
                onDelete={setConfirm}
                disabled={busy || blocked}
              />
            )}
          </section>
          <footer className="panel travel-footer">
            <p className="hint">* 为提交必填项，草稿可稍后补全</p>
            <div className="actions">
              {draft && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setConfirm("draft")}
                >
                  删除草稿
                </button>
              )}
              <button className="button secondary" type="submit">
                {busy ? "处理中…" : "保存草稿"}
              </button>
              <button className="button" type="button" onClick={checkSubmit}>
                提交申请
              </button>
            </div>
          </footer>
        </fieldset>
      </form>
      {confirm && (
        <TravelDialog
          title={
            confirm === "submit"
              ? "确认提交申请"
              : confirm === "draft"
                ? "确认删除草稿"
                : "确认删除附件"
          }
          close={() => setConfirm(null)}
          busy={busy}
        >
          <p>
            {confirm === "submit"
              ? "将保存当前填写内容并提交审批。提交后不能修改表单或附件。"
              : confirm === "draft"
                ? "将删除此草稿及其全部附件，此操作不能撤销。"
                : `将删除附件“${confirm.originalName}”。`}
          </p>
          <div className="actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void confirmedAction()}
            >
              {busy
                ? "处理中…"
                : confirm === "submit"
                  ? "确认提交"
                  : "确认删除"}
            </button>
          </div>
        </TravelDialog>
      )}
    </div>
  );
}
