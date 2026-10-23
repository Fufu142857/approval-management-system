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
  reimbursementDraftSchema,
  type ReimbursementDraft,
  type ReimbursementDraftInput,
  type ReimbursementLinkSummary,
} from "@/lib/reimbursement";
import {
  reimbursementFields,
  reimbursementAmount,
  reimbursementCategoryNames,
} from "@/lib/reimbursement-display";
import {
  receiptNumberSchema,
  type ReimbursementAttachment,
} from "@/lib/reimbursement-attachments";
import { ReimbursementSourcePicker } from "./reimbursement-source-picker";
import { reimbursementSubmissionIssues } from "@/lib/reimbursement-submission";
import type { ReimbursementDetail } from "@/lib/reimbursement-display";
import {
  maxAttachmentBytes,
  maxAttachments,
  maxApplicationAttachmentBytes,
  type Attachment,
} from "@/lib/attachments";
import { fileSize } from "@/lib/travel-display";
import { useResource } from "./use-resource";
import { Icon } from "./icons";
import { Field, Notice } from "./ui";
import { AttachmentItems, TravelDialog, TravelFailure } from "./travel-common";

type Props = { applicant: string; department: string };
type FileList = { items: ReimbursementAttachment[]; version: number };
export function ExistingReimbursementEditor({
  id,
  ...props
}: Props & { id: string }) {
  const draft = useResource<ReimbursementDraft>(`/reimbursement-drafts/${id}`);
  const files = useResource<FileList>(
    `/reimbursement-drafts/${id}/attachments`,
  );
  const reload = () => {
    draft.reload();
    files.reload();
  };
  if (draft.error || files.error)
    return (
      <div className="stack">
        <TravelFailure message={draft.error || files.error!} retry={reload} />
        <p className="hint">若已通过其他客户端提交，此处不能继续编辑。</p>
        <Link href={`/reimbursement/applications/${id}`}>查看提交后详情</Link>
        <Link href="/reimbursement/drafts">返回报销草稿</Link>
      </div>
    );
  if (!draft.data || !files.data)
    return (
      <p role="status" className="empty-state">
        正在加载报销草稿…
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
    <ReimbursementEditor
      key={`${id}:${draft.data.version}`}
      {...props}
      initial={draft.data}
      initialFiles={files.data.items}
    />
  );
}
export function ReimbursementEditor({
  applicant,
  department,
  initial,
  initialFiles = [],
}: Props & {
  initial?: ReimbursementDraft;
  initialFiles?: ReimbursementAttachment[];
}) {
  const [draft, setDraft] = useState(initial);
  const [form, setForm] = useState(() => reimbursementFields(initial));
  const [files, setFiles] = useState(initialFiles);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [confirm, setConfirm] = useState<
    "submit" | "draft" | Attachment | null
  >(null);
  const [selectedSources, setSelectedSources] = useState<
    ReimbursementLinkSummary[]
  >(initial?.linkedApplications ?? []);
  const [itemId, setItemId] = useState("");
  const [receiptNumber, setReceiptNumber] = useState("");
  const locked = useRef(false);
  const leaving = useRef(false);
  const inputFile = useRef<HTMLInputElement>(null);
  const dirty =
    JSON.stringify(form) !== JSON.stringify(reimbursementFields(draft));
  const amounts = reimbursementAmount(form.items);
  const savedItems = form.items.filter(
    (item) => item.id && draft?.items.some((saved) => saved.id === item.id),
  );
  const uploadItem =
    savedItems.find((item) => item.id === itemId)?.id ??
    savedItems[0]?.id ??
    "";
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
  async function run(work: () => Promise<unknown>) {
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
        if (confirm === "submit")
          setMessage("提交未确认完成，请核对错误说明和服务器记录。");
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
          if (
            error.status === 0 ||
            error.status >= 500 ||
            [
              "VERSION_CONFLICT",
              "NOT_DRAFT",
              "VERSION_LIMIT",
              "NOT_FOUND",
              "ITEM_HAS_ATTACHMENTS",
              "INVALID_ROW_ID",
            ].includes(error.code ?? "") ||
            error.status === 404
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
  function focusField(name: string) {
    const target = document.getElementById(name);
    const details = target?.closest("details");
    if (details) details.open = true;
    target?.focus();
  }
  function validate(complete = false) {
    setMessage("");
    const parsed = reimbursementDraftSchema.safeParse(form);
    const issues = parsed.success
      ? complete
        ? reimbursementSubmissionIssues(parsed.data, files)
        : []
      : parsed.error.issues;
    if (issues.length) {
      const result: Record<string, string> = {};
      for (const issue of issues)
        result[issue.path.join("-")] ??= issue.message;
      setErrors(result);
      setError("请检查标出的字段后重试。");
      focusField(Object.keys(result)[0]);
      return;
    }
    setErrors({});
    return parsed.success ? parsed.data : undefined;
  }
  async function save(data: ReimbursementDraftInput) {
    if (draft && !dirty) {
      setMessage("草稿已保存。");
      return draft;
    }
    const saved = await api<ReimbursementDraft>(
      draft ? `/reimbursement-drafts/${draft.id}` : "/reimbursement-drafts",
      {
        method: draft ? "PUT" : "POST",
        body: JSON.stringify(
          draft ? { ...data, version: draft.version } : data,
        ),
      },
    );
    setDraft(saved);
    setForm(reimbursementFields(saved));
    setSelectedSources(saved.linkedApplications);
    setMessage("草稿已保存。");
    if (!draft)
      window.history.replaceState(
        null,
        "",
        `/reimbursement/drafts/${saved.id}`,
      );
    return saved;
  }
  async function confirmedAction() {
    const data = confirm === "submit" ? validate(true) : undefined;
    if (confirm === "submit" && !data) {
      setConfirm(null);
      return;
    }
    await run(async () => {
      if (confirm === "submit" && data) {
        const saved = await save(data);
        const result = await api<ReimbursementDetail>(
          `/reimbursement-drafts/${saved.id}/submit`,
          { method: "POST", body: JSON.stringify({ version: saved.version }) },
        );
        leaving.current = true;
        window.location.replace(
          `/reimbursement/applications/${result.application.id}`,
        );
      } else if (confirm === "draft" && draft) {
        await api(`/reimbursement-drafts/${draft.id}`, {
          method: "DELETE",
          body: JSON.stringify({ version: draft.version }),
        });
        leaving.current = true;
        window.location.replace("/reimbursement/drafts");
      } else if (confirm && typeof confirm === "object" && draft) {
        const result = await api<{ version: number }>(
          `/reimbursement-drafts/${draft.id}/attachments/${confirm.id}`,
          {
            method: "DELETE",
            body: JSON.stringify({ version: draft.version }),
          },
        );
        setFiles(files.filter((file) => file.id !== confirm.id));
        setDraft({ ...draft, version: result.version });
        setMessage("附件已删除；未保存的表单修改仍保留。");
      }
    });
  }
  async function upload(file: File) {
    if (!draft || !uploadItem) return;
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
      const number = receiptNumberSchema.safeParse(receiptNumber);
      if (!number.success) {
        setError(number.error.issues[0].message);
        return;
      }
      const body = new FormData();
      body.set("receiptNumber", number.data);
      body.set("file", file);
      body.set("version", String(draft.version));
      const result = await api<{
        attachment: ReimbursementAttachment;
        version: number;
      }>(`/reimbursement-drafts/${draft.id}/items/${uploadItem}/attachments`, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(60000),
      });
      setFiles([...files, result.attachment]);
      setReceiptNumber("");
      setDraft({ ...draft, version: result.version });
      setMessage("附件已上传；表单中未保存的修改仍需保存。");
    });
  }
  function input(
    name: string,
    value: string | null,
    change: (value: string) => void,
  ) {
    return {
      id: name,
      value: value ?? "",
      "aria-invalid": !!errors[name],
      "aria-describedby": errors[name] ? `${name}-error` : undefined,
      onChange: (
        event: React.ChangeEvent<
          HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        >,
      ) => change(event.target.value),
    };
  }
  function field(
    name: "title" | "description" | "independentReason" | "remarks",
  ) {
    return input(name, form[name], (value) =>
      setForm({ ...form, [name]: value }),
    );
  }
  function itemField(
    index: number,
    name: "expenseDate" | "purpose" | "amount" | "noReceiptReason",
  ) {
    return input(`items-${index}-${name}`, form.items[index][name], (value) =>
      setForm({
        ...form,
        items: form.items.map((item, i) =>
          i === index
            ? {
                ...item,
                [name]: ["expenseDate", "amount"].includes(name)
                  ? value || null
                  : value,
              }
            : item,
        ),
      }),
    );
  }
  function move(index: number, offset: number) {
    const items = [...form.items];
    [items[index], items[index + offset]] = [
      items[index + offset],
      items[index],
    ];
    setForm({ ...form, items });
  }
  return (
    <div className="stack purchase-workspace reimbursement-workspace">
      <div className="section-heading">
        <Link href="/reimbursement/drafts" className="text-button">
          ← 返回报销草稿
        </Link>
        <span className="hint">
          {draft?.appNo ?? "新建申请"} · 草稿{dirty ? " · 有未保存修改" : ""}
        </span>
      </div>
      <noscript>
        <Notice>请启用 JavaScript 后填写与保存报销申请。</Notice>
      </noscript>
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {!!Object.keys(errors).length && (
        <Notice error>
          <ul>
            {Object.entries(errors).map(([key, text]) => (
              <li
                key={key}
                id={key.startsWith("items") ? `${key}-error` : undefined}
              >
                <a href={`#${key}`} onClick={() => focusField(key)}>
                  {key.startsWith("items-")
                    ? `费用 ${Number(key.split("-")[1]) + 1}：`
                    : ""}
                  {text}
                </a>
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {blocked && (
        <Notice error>
          <p>
            结果可能已变化。当前输入仍保留，请先查看服务器记录，确认后重新加载；不要重复提交。
          </p>
          <div className="actions">
            <button
              type="button"
              className="button secondary"
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
                draft
                  ? `/reimbursement/drafts/${draft.id}`
                  : "/reimbursement/drafts"
              }
            >
              新窗口查看服务器记录
            </a>
            {draft && (
              <a
                className="text-button"
                target="_blank"
                rel="noreferrer"
                href={`/reimbursement/applications/${draft.id}`}
              >
                新窗口核对提交结果
              </a>
            )}
          </div>
        </Notice>
      )}
      <form
        method="post"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (locked.current || blocked) return;
          const data = validate();
          if (data) void run(() => save(data));
        }}
      >
        <fieldset
          disabled={busy || blocked}
          className="stack purchase-sections"
        >
          <section className="panel purchase-section">
            <h2>基本信息</h2>
            <div className="purchase-basic-grid">
              <Field name="title" label="申请标题" error={errors.title}>
                <input
                  {...field("title")}
                  maxLength={200}
                  placeholder="请输入报销申请标题"
                />
              </Field>
              <Field name="department" label="申请部门">
                <input id="department" value={department} readOnly />
              </Field>
              <Field name="applicant" label="申请人">
                <input id="applicant" value={applicant} readOnly />
              </Field>
              <Field name="createdDate" label="申请日期">
                <input
                  id="createdDate"
                  value={
                    draft
                      ? new Intl.DateTimeFormat("sv-SE", {
                          timeZone: "Asia/Shanghai",
                        }).format(new Date(draft.createdAt))
                      : "保存时生成"
                  }
                  readOnly
                />
              </Field>
            </div>
            <Field
              name="description"
              label="报销说明"
              error={errors.description}
            >
              <textarea
                {...field("description")}
                rows={2}
                maxLength={2000}
                placeholder="说明本次费用用途"
              />
            </Field>
          </section>
          <section className="panel purchase-section" aria-label="关联申请">
            <h2>关联申请 / 独立报销</h2>
            <ReimbursementSourcePicker
              selected={selectedSources}
              disabled={busy || blocked}
              onChange={(items) => {
                setSelectedSources(items);
                setForm({
                  ...form,
                  linkedApplicationIds: items.map((item) => item.id),
                });
              }}
            />
            <Field
              name="independentReason"
              label="独立报销说明"
              error={errors.independentReason}
              hint="不关联已批申请时，请说明独立支出原因；草稿可稍后补全。"
            >
              <textarea
                {...field("independentReason")}
                rows={2}
                maxLength={2000}
              />
            </Field>
          </section>
          <section className="panel purchase-section" aria-label="费用明细">
            <div className="section-heading">
              <h2>费用明细</h2>
              <button
                type="button"
                className="button secondary compact"
                disabled={form.items.length >= 100}
                onClick={() =>
                  setForm({
                    ...form,
                    items: [
                      ...form.items,
                      {
                        category: null,
                        expenseDate: null,
                        purpose: "",
                        amount: null,
                        noReceipt: false,
                        noReceiptReason: "",
                      },
                    ],
                  })
                }
              >
                ＋ 添加费用
              </button>
            </div>
            <p className="scroll-hint">左右滑动可填写完整费用明细</p>
            <div
              className="table-scroll"
              role="region"
              aria-label="费用明细表格"
              tabIndex={0}
            >
              <table
                className="reimbursement-item-table"
                id="items"
                tabIndex={-1}
              >
                <thead>
                  <tr>
                    <th>序号</th>
                    <th>费用类型</th>
                    <th>发生日期</th>
                    <th>用途</th>
                    <th>金额（元）</th>
                    <th>票据 / 无票说明</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {form.items.map((item, index) => (
                    <tr
                      key={item.id ?? `new-${index}`}
                      id={`items-${index}`}
                      tabIndex={-1}
                    >
                      <td>{index + 1}</td>
                      <td>
                        <select
                          id={`items-${index}-category`}
                          aria-label={`费用 ${index + 1} 类型`}
                          value={item.category ?? ""}
                          aria-invalid={!!errors[`items-${index}-category`]}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              items: form.items.map((row, i) =>
                                i === index
                                  ? {
                                      ...row,
                                      category: (event.target.value ||
                                        null) as typeof row.category,
                                    }
                                  : row,
                              ),
                            })
                          }
                        >
                          <option value="">请选择</option>
                          {Object.entries(reimbursementCategoryNames).map(
                            ([value, name]) => (
                              <option value={value} key={value}>
                                {name}
                              </option>
                            ),
                          )}
                        </select>
                      </td>
                      <td>
                        <input
                          {...itemField(index, "expenseDate")}
                          aria-label={`费用 ${index + 1} 日期`}
                          type="date"
                          min="0001-01-01"
                          max="9999-12-31"
                        />
                      </td>
                      <td>
                        <textarea
                          {...itemField(index, "purpose")}
                          aria-label={`费用 ${index + 1} 用途`}
                          rows={2}
                          maxLength={2000}
                        />
                      </td>
                      <td>
                        <input
                          {...itemField(index, "amount")}
                          aria-label={`费用 ${index + 1} 金额`}
                          inputMode="decimal"
                          maxLength={15}
                        />
                      </td>
                      <td>
                        <span className="hint">
                          {
                            files.filter((file) => file.itemId === item.id)
                              .length
                          }{" "}
                          件已上传票据
                        </span>
                        <label className="purchase-checkbox">
                          <input
                            type="checkbox"
                            checked={item.noReceipt}
                            onChange={(event) =>
                              setForm({
                                ...form,
                                items: form.items.map((row, i) =>
                                  i === index
                                    ? {
                                        ...row,
                                        noReceipt: event.target.checked,
                                      }
                                    : row,
                                ),
                              })
                            }
                          />
                          费用 {index + 1} 无票支出
                        </label>
                        {(item.noReceipt || item.noReceiptReason) && (
                          <textarea
                            {...itemField(index, "noReceiptReason")}
                            aria-label={`费用 ${index + 1} 无票原因`}
                            rows={2}
                            maxLength={2000}
                            placeholder="说明无法提供票据的原因"
                          />
                        )}
                        {item.noReceipt &&
                          files.some((file) => file.itemId === item.id) && (
                            <p className="hint">已有票据，请核对无票标记。</p>
                          )}
                      </td>
                      <td>
                        <div className="reimbursement-row-actions">
                          <button
                            type="button"
                            className="text-button"
                            disabled={index === 0}
                            aria-label={`上移费用 ${index + 1}`}
                            onClick={() => move(index, -1)}
                          >
                            上移
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            disabled={index === form.items.length - 1}
                            aria-label={`下移费用 ${index + 1}`}
                            onClick={() => move(index, 1)}
                          >
                            下移
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`删除费用 ${index + 1}`}
                            disabled={files.some(
                              (file) => file.itemId === item.id,
                            )}
                            title={
                              files.some((file) => file.itemId === item.id)
                                ? "请先删除此费用的全部票据"
                                : "保存后删除费用"
                            }
                            onClick={() =>
                              setForm({
                                ...form,
                                items: form.items.filter((_, i) => i !== index),
                              })
                            }
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!form.items.length && (
              <p className="empty-state">暂无费用，请添加明细。</p>
            )}
            <p className="purchase-total" role="status">
              报销合计：
              <strong>
                {amounts.overflow
                  ? "超过金额上限"
                  : amounts.total === null
                    ? "待补全金额"
                    : `${amounts.total} 元`}
              </strong>{" "}
              · 无票支出 {form.items.filter((item) => item.noReceipt).length} 项
            </p>
            <p className="hint">
              最多 100
              条费用。已填金额须大于零、最多两位小数；未填完可保存草稿。每项费用需票据或无票原因，上传不会自动取消无票标记。
            </p>
          </section>
          <section className="panel purchase-section" aria-label="票据附件">
            <h2>票据附件</h2>
            <div className="purchase-extra-grid">
              <Field name="attachmentItem" label="票据所属费用">
                <select
                  id="attachmentItem"
                  value={uploadItem}
                  onChange={(event) => setItemId(event.target.value)}
                  disabled={!savedItems.length}
                >
                  <option value="" disabled>
                    先保存至少一条费用
                  </option>
                  {savedItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      费用 {form.items.indexOf(item) + 1} ·{" "}
                      {item.purpose || "未填写用途"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field name="receiptNumber" label="票据号码（选填）">
                <input
                  id="receiptNumber"
                  value={receiptNumber}
                  maxLength={100}
                  disabled={!uploadItem}
                  onChange={(event) => setReceiptNumber(event.target.value)}
                />
              </Field>
            </div>
            <div
              className="upload-zone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (!busy && !blocked && uploadItem) {
                  if (event.dataTransfer.files.length !== 1)
                    setError("请每次上传一份票据。");
                  else void upload(event.dataTransfer.files[0]);
                }
              }}
            >
              <button
                type="button"
                className="text-button"
                disabled={!uploadItem}
                onClick={() => inputFile.current?.click()}
              >
                <Icon name="upload" />
                点击上传 或拖拽票据到此处
              </button>
              <input
                ref={inputFile}
                type="file"
                hidden
                aria-label="选择费用票据"
                accept=".jpg,.jpeg,.png,.pdf"
                disabled={!uploadItem}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void upload(file);
                }}
              />
              <p className="hint">
                JPEG、PNG、PDF，单件 ≤ 10 MiB；整单 {files.length}/9 件 ·{" "}
                {fileSize(files.reduce((sum, file) => sum + file.sizeBytes, 0))}
                /50 MiB
              </p>
              {!uploadItem && (
                <p className="hint">先保存费用明细，再上传票据。</p>
              )}
            </div>
            <p className="hint">
              号码随本次上传保存；号码或归属填错时请删除后重新上传。上传和删除票据不会保存表单修改。
            </p>
            {draft &&
              form.items
                .filter((item) => files.some((file) => file.itemId === item.id))
                .map((item) => (
                  <div className="purchase-file-group" key={item.id}>
                    <h3>
                      费用 {form.items.indexOf(item) + 1} ·{" "}
                      {item.purpose || "未填写用途"}
                    </h3>
                    {files
                      .filter((file) => file.itemId === item.id)
                      .map((file) => (
                        <div key={file.id} className="reimbursement-receipt">
                          <p className="hint">
                            票据号码：{file.receiptNumber || "未填写"}
                          </p>
                          <AttachmentItems
                            appId={draft.id}
                            resource="reimbursement-drafts"
                            items={[file]}
                            onDelete={setConfirm}
                            disabled={busy || blocked}
                          />
                        </div>
                      ))}
                  </div>
                ))}
            <Field name="remarks" label="补充备注" error={errors.remarks}>
              <textarea {...field("remarks")} rows={2} maxLength={2000} />
            </Field>
            <div className="section-heading reimbursement-footer">
              <p className="hint">
                提交前会保存当前内容；提交后表单与票据不可修改。
              </p>
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
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    if (!locked.current && !blocked && validate(true))
                      setConfirm("submit");
                  }}
                >
                  提交申请
                </button>
              </div>
            </div>
          </section>
        </fieldset>
      </form>
      {confirm && (
        <TravelDialog
          title={
            confirm === "submit"
              ? "确认提交报销申请"
              : confirm === "draft"
                ? "确认删除草稿"
                : "确认删除票据"
          }
          close={() => setConfirm(null)}
          busy={busy}
        >
          <p>
            {confirm === "submit"
              ? "将保存当前内容并提交审批。提交后不能修改费用、关联来源或票据。"
              : confirm === "draft"
                ? "将删除此草稿及其全部费用、关联和票据，此操作不能撤销。原关联申请保持不变。"
                : `将删除票据“${confirm.originalName}”。`}
          </p>
          {confirm === "submit" && (
            <dl className="travel-details">
              <div className="travel-span">
                <dt>申请</dt>
                <dd>
                  {draft?.appNo ?? "保存时分配编号"} · {form.title}
                </dd>
              </div>
              <div>
                <dt>报销总额</dt>
                <dd>{amounts.total} 元</dd>
              </div>
              <div>
                <dt>无票支出</dt>
                <dd>
                  {form.items.filter((item) => item.noReceipt).length}{" "}
                  项（已填写原因）
                </dd>
              </div>
              <div className="travel-span">
                <dt>关联来源</dt>
                <dd>
                  {selectedSources.length
                    ? selectedSources
                        .map((source) => `${source.appNo} · ${source.title}`)
                        .join("；")
                    : `独立报销：${form.independentReason}`}
                </dd>
              </div>
              <div className="travel-span">
                <dt>审批路径</dt>
                <dd>部门负责人 → 财务审批人（实际人员提交时确定）</dd>
              </div>
            </dl>
          )}
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
