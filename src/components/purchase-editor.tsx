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
  purchaseDraftSchema,
  type PurchaseDraft,
  type PurchaseDraftInput,
} from "@/lib/purchase";
import { purchaseSubmissionIssues } from "@/lib/purchase-submission";
import {
  purchaseFields,
  purchaseAmounts,
  type PurchaseDetail,
} from "@/lib/purchase-display";
import type { PurchaseAttachment } from "@/lib/purchase-attachments";
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
type FileList = { items: PurchaseAttachment[]; version: number };
export function ExistingPurchaseEditor({
  id,
  ...props
}: Props & { id: string }) {
  const draft = useResource<PurchaseDraft>(`/purchase-drafts/${id}`);
  const files = useResource<FileList>(`/purchase-drafts/${id}/attachments`);
  const reload = () => {
    draft.reload();
    files.reload();
  };
  if (draft.error || files.error)
    return (
      <div className="stack">
        <TravelFailure message={draft.error || files.error!} retry={reload} />
        <Link href={`/purchase/applications/${id}`}>查看已提交申请</Link>
        <Link href="/purchase/drafts">返回采购草稿</Link>
      </div>
    );
  if (!draft.data || !files.data)
    return (
      <p role="status" className="empty-state">
        正在加载采购草稿…
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
    <PurchaseEditor
      key={`${id}:${draft.data.version}`}
      {...props}
      initial={draft.data}
      initialFiles={files.data.items}
    />
  );
}
export function PurchaseEditor({
  applicant,
  department,
  initial,
  initialFiles = [],
}: Props & { initial?: PurchaseDraft; initialFiles?: PurchaseAttachment[] }) {
  const [draft, setDraft] = useState(initial);
  const [form, setForm] = useState(() => purchaseFields(initial));
  const [files, setFiles] = useState(initialFiles);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [confirm, setConfirm] = useState<
    "submit" | "draft" | Attachment | null
  >(null);
  const [quoteId, setQuoteId] = useState("");
  const locked = useRef(false);
  const leaving = useRef(false);
  const inputFile = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(purchaseFields(draft));
  const amounts = purchaseAmounts(form.items);
  const savedQuotes = form.quotes.filter(
    (quote) => quote.id && draft?.quotes.some((saved) => saved.id === quote.id),
  );
  const uploadQuote =
    savedQuotes.find((quote) => quote.id === quoteId)?.id ??
    savedQuotes[0]?.id ??
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
              "QUOTE_HAS_ATTACHMENTS",
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
    const parsed = purchaseDraftSchema.safeParse(form);
    const issues = parsed.success
      ? complete
        ? purchaseSubmissionIssues(parsed.data, files)
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
  async function save(data: PurchaseDraftInput) {
    if (draft && !dirty) {
      setMessage("草稿已保存。");
      return draft;
    }
    const saved = await api<PurchaseDraft>(
      draft ? `/purchase-drafts/${draft.id}` : "/purchase-drafts",
      {
        method: draft ? "PUT" : "POST",
        body: JSON.stringify(
          draft ? { ...data, version: draft.version } : data,
        ),
      },
    );
    setDraft(saved);
    setForm(purchaseFields(saved));
    setMessage("草稿已保存。");
    if (!draft)
      window.history.replaceState(null, "", `/purchase/drafts/${saved.id}`);
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
        const result = await api<PurchaseDetail>(
          `/purchase-drafts/${saved.id}/submit`,
          {
            method: "POST",
            body: JSON.stringify({ version: saved.version }),
          },
        );
        leaving.current = true;
        window.location.replace(
          `/purchase/applications/${result.application.id}`,
        );
      } else if (confirm === "draft" && draft) {
        await api(`/purchase-drafts/${draft.id}`, {
          method: "DELETE",
          body: JSON.stringify({ version: draft.version }),
        });
        leaving.current = true;
        window.location.replace("/purchase/drafts");
      } else if (confirm && typeof confirm === "object" && draft) {
        const result = await api<{ version: number }>(
          `/purchase-drafts/${draft.id}/attachments/${confirm.id}`,
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
    if (!draft || !uploadQuote) return;
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
      const result = await api<{
        attachment: PurchaseAttachment;
        version: number;
      }>(`/purchase-drafts/${draft.id}/quotes/${uploadQuote}/attachments`, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(60000),
      });
      setFiles([...files, result.attachment]);
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
        event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => change(event.target.value),
    };
  }
  function field(
    name:
      | "title"
      | "reason"
      | "expectedDate"
      | "project"
      | "budgetLimit"
      | "selectionReason"
      | "singleSourceReason"
      | "remarks",
  ) {
    return input(name, form[name], (value) =>
      setForm({
        ...form,
        [name]: ["expectedDate", "budgetLimit"].includes(name)
          ? value || null
          : value,
      }),
    );
  }
  function itemField(
    index: number,
    name: keyof Omit<PurchaseDraftInput["items"][number], "id">,
  ) {
    return input(`items-${index}-${name}`, form.items[index][name], (value) =>
      setForm({
        ...form,
        items: form.items.map((item, i) =>
          i === index
            ? {
                ...item,
                [name]: ["quantity", "unitPrice"].includes(name)
                  ? value || null
                  : value,
              }
            : item,
        ),
      }),
    );
  }
  function quoteField(
    index: number,
    name: "supplierName" | "quoteDate" | "amount" | "basis" | "purchaseUrl",
  ) {
    return input(`quotes-${index}-${name}`, form.quotes[index][name], (value) =>
      setForm({
        ...form,
        quotes: form.quotes.map((quote, i) =>
          i === index
            ? {
                ...quote,
                [name]: ["quoteDate", "amount"].includes(name)
                  ? value || null
                  : value,
              }
            : quote,
        ),
      }),
    );
  }
  return (
    <div className="stack purchase-workspace">
      <div className="section-heading">
        <Link href="/purchase/drafts" className="text-button">
          ← 返回采购草稿
        </Link>
        <span className="hint">
          {draft?.appNo ?? "新建申请"} · 草稿{dirty ? " · 有未保存修改" : ""}
        </span>
      </div>
      <noscript>
        <Notice>请启用 JavaScript 后填写与保存采购申请。</Notice>
      </noscript>
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {Object.keys(errors).length > 0 && (
        <Notice error>
          <ul>
            {Object.entries(errors).map(([key, text]) => (
              <li
                key={key}
                id={
                  /^(items|quotes)(-|$)/.test(key) &&
                  !key.endsWith("-basis") &&
                  !key.endsWith("-purchaseUrl")
                    ? `${key}-error`
                    : undefined
                }
              >
                <a href={`#${key}`} onClick={() => focusField(key)}>
                  {key.startsWith("items-")
                    ? `明细 ${Number(key.split("-")[1]) + 1}：`
                    : key.startsWith("quotes-")
                      ? `报价 ${Number(key.split("-")[1]) + 1}：`
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
            {draft && (
              <a
                className="text-button"
                target="_blank"
                rel="noreferrer"
                href={`/purchase/applications/${draft.id}`}
              >
                新窗口查看提交结果
              </a>
            )}
            <a
              className="text-button"
              target="_blank"
              rel="noreferrer"
              href={draft ? `/purchase/drafts/${draft.id}` : "/purchase/drafts"}
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
              <Field name="title" label="申请标题 *" error={errors.title}>
                <input
                  {...field("title")}
                  maxLength={200}
                  placeholder="请输入采购申请标题"
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
            <Field name="reason" label="采购原因 *" error={errors.reason}>
              <textarea
                {...field("reason")}
                maxLength={2000}
                rows={2}
                placeholder="说明采购用途与必要性"
              />
            </Field>
            <div className="purchase-extra-grid">
              <Field
                name="expectedDate"
                label="期望到货日期 *"
                error={errors.expectedDate}
              >
                <input
                  {...field("expectedDate")}
                  type="date"
                  min="0001-01-01"
                  max="9999-12-31"
                />
              </Field>
              <Field name="project" label="所属项目" error={errors.project}>
                <input
                  {...field("project")}
                  maxLength={200}
                  placeholder="选填"
                />
              </Field>
              <Field
                name="budgetLimit"
                label="预算上限（元）*"
                error={errors.budgetLimit}
              >
                <input
                  {...field("budgetLimit")}
                  inputMode="decimal"
                  maxLength={15}
                  placeholder="0.00"
                />
              </Field>
            </div>
          </section>
          <section
            className="panel purchase-section"
            aria-labelledby="items-heading"
          >
            <div className="section-heading">
              <h2 id="items-heading">采购明细</h2>
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
                        name: "",
                        specification: "",
                        quantity: null,
                        unit: "",
                        unitPrice: null,
                      },
                    ],
                  })
                }
              >
                ＋ 添加明细
              </button>
            </div>
            <p className="scroll-hint">左右滑动可填写完整明细</p>
            <div
              className="table-scroll"
              role="region"
              aria-label="采购明细表格"
              tabIndex={0}
            >
              <table id="items" tabIndex={-1} className="purchase-item-table">
                <thead>
                  <tr>
                    <th>序号</th>
                    <th>名称 *</th>
                    <th>规格型号 *</th>
                    <th>数量 *</th>
                    <th>单位 *</th>
                    <th>单价（元）*</th>
                    <th>金额（元）</th>
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
                        <input
                          {...itemField(index, "name")}
                          aria-label={`明细 ${index + 1} 名称`}
                          maxLength={200}
                        />
                      </td>
                      <td>
                        <input
                          {...itemField(index, "specification")}
                          aria-label={`明细 ${index + 1} 规格型号`}
                          maxLength={500}
                        />
                      </td>
                      <td>
                        <input
                          {...itemField(index, "quantity")}
                          aria-label={`明细 ${index + 1} 数量`}
                          inputMode="decimal"
                          maxLength={13}
                        />
                      </td>
                      <td>
                        <input
                          {...itemField(index, "unit")}
                          aria-label={`明细 ${index + 1} 单位`}
                          maxLength={40}
                        />
                      </td>
                      <td>
                        <input
                          {...itemField(index, "unitPrice")}
                          aria-label={`明细 ${index + 1} 单价`}
                          inputMode="decimal"
                          maxLength={15}
                        />
                      </td>
                      <td>
                        <output aria-label={`明细 ${index + 1} 金额`}>
                          {amounts.lines[index] ?? "—"}
                        </output>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="text-button"
                          aria-label={`删除明细 ${index + 1}`}
                          onClick={() =>
                            setForm({
                              ...form,
                              items: form.items.filter((_, i) => i !== index),
                            })
                          }
                        >
                          <Icon name="trash" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!form.items.length && (
              <p className="empty-state">暂无采购明细，请添加明细。</p>
            )}
            <p className="purchase-total" role="status">
              预计总额：
              <strong>
                {amounts.overflow
                  ? "超过金额上限"
                  : amounts.total === null
                    ? "待补全明细"
                    : `${amounts.total} 元`}
              </strong>
            </p>
          </section>
          <section
            className="panel purchase-section"
            aria-labelledby="quotes-heading"
          >
            <div className="section-heading">
              <h2 id="quotes-heading">供应商报价</h2>
              <button
                type="button"
                className="button secondary compact"
                disabled={form.quotes.length >= 20}
                onClick={() =>
                  setForm({
                    ...form,
                    quotes: [
                      ...form.quotes,
                      {
                        supplierName: "",
                        quoteDate: null,
                        amount: null,
                        basis: "",
                        purchaseUrl: "",
                        isOnline: false,
                        selected: false,
                      },
                    ],
                  })
                }
              >
                ＋ 新增供应商报价
              </button>
            </div>
            <p className="scroll-hint">左右滑动可填写完整报价</p>
            <div
              className="table-scroll"
              role="region"
              aria-label="供应商报价表格"
              tabIndex={0}
            >
              <table id="quotes" tabIndex={-1} className="purchase-quote-table">
                <thead>
                  <tr>
                    <th>序号</th>
                    <th>供应商名称 *</th>
                    <th>报价日期 *</th>
                    <th>报价金额（元）</th>
                    <th>购买链接 / 报价依据</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {form.quotes.map((quote, index) => (
                    <tr
                      key={quote.id ?? `new-${index}`}
                      id={`quotes-${index}`}
                      tabIndex={-1}
                    >
                      <td>{index + 1}</td>
                      <td>
                        <input
                          {...quoteField(index, "supplierName")}
                          aria-label={`报价 ${index + 1} 供应商名称`}
                          maxLength={200}
                        />
                      </td>
                      <td>
                        <input
                          {...quoteField(index, "quoteDate")}
                          aria-label={`报价 ${index + 1} 日期`}
                          type="date"
                          min="0001-01-01"
                          max="9999-12-31"
                        />
                      </td>
                      <td>
                        <input
                          {...quoteField(index, "amount")}
                          aria-label={`报价 ${index + 1} 金额`}
                          inputMode="decimal"
                          maxLength={15}
                          placeholder="金额或填写依据"
                        />
                      </td>
                      <td>
                        <details className="purchase-quote-evidence">
                          <summary>
                            链接 / 依据 ·{" "}
                            {
                              files.filter((file) => file.quoteId === quote.id)
                                .length
                            }{" "}
                            件附件
                          </summary>
                          <label className="purchase-checkbox">
                            <input
                              type="checkbox"
                              checked={quote.isOnline}
                              onChange={(event) =>
                                setForm({
                                  ...form,
                                  quotes: form.quotes.map((row, i) =>
                                    i === index
                                      ? {
                                          ...row,
                                          isOnline: event.target.checked,
                                        }
                                      : row,
                                  ),
                                })
                              }
                            />
                            线上报价 {index + 1}
                          </label>
                          <Field
                            name={`quotes-${index}-purchaseUrl`}
                            label="购买链接"
                            error={errors[`quotes-${index}-purchaseUrl`]}
                          >
                            <input
                              {...quoteField(index, "purchaseUrl")}
                              type="url"
                              maxLength={2000}
                              placeholder="https://"
                            />
                          </Field>
                          <Field
                            name={`quotes-${index}-basis`}
                            label="报价依据 / 明细"
                            error={errors[`quotes-${index}-basis`]}
                          >
                            <textarea
                              {...quoteField(index, "basis")}
                              rows={2}
                              maxLength={2000}
                            />
                          </Field>
                          <a href="#purchase-attachments">
                            管理此报价附件（在下方选择报价）
                          </a>
                        </details>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="text-button"
                          aria-label={`删除报价 ${index + 1}`}
                          disabled={files.some(
                            (file) => file.quoteId === quote.id,
                          )}
                          title={
                            files.some((file) => file.quoteId === quote.id)
                              ? "请先删除此报价的附件"
                              : "删除报价，保存后生效"
                          }
                          onClick={() =>
                            setForm({
                              ...form,
                              quotes: form.quotes.filter((_, i) => i !== index),
                            })
                          }
                        >
                          <Icon name="trash" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!form.quotes.length && (
              <p className="empty-state">暂无供应商报价，请新增报价。</p>
            )}
            <p className="hint">
              通常需至少两家供应商比价；单一来源需说明原因。线上报价需购买链接及该报价的图片凭据；含附件的报价请先删除附件。
            </p>
          </section>
          <div className="purchase-choice-grid">
            <section className="panel purchase-section">
              <h2>采购选择</h2>
              <Field name="selectedQuote" label="选择供应商 *">
                <select
                  id="selectedQuote"
                  value={String(
                    form.quotes.findIndex((quote) => quote.selected),
                  )}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      quotes: form.quotes.map((quote, index) => ({
                        ...quote,
                        selected: index === Number(event.target.value),
                      })),
                    })
                  }
                >
                  <option value="-1">请选择供应商</option>
                  {form.quotes.map((quote, index) => (
                    <option key={quote.id ?? index} value={index}>
                      {index + 1}. {quote.supplierName || "未命名供应商"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                name="selectionReason"
                label="选择原因 *"
                error={errors.selectionReason}
              >
                <textarea
                  {...field("selectionReason")}
                  maxLength={2000}
                  rows={3}
                  placeholder="说明价格、质量、交期等选择依据；未选最低价时说明原因"
                />
              </Field>
            </section>
            <section className="panel purchase-section">
              <h2>单一来源说明（如适用）</h2>
              <label className="purchase-checkbox">
                <input
                  type="checkbox"
                  checked={form.singleSource}
                  onChange={(event) =>
                    setForm({ ...form, singleSource: event.target.checked })
                  }
                />
                采用单一来源采购
              </label>
              <Field
                name="singleSourceReason"
                label="单一来源原因"
                error={errors.singleSourceReason}
              >
                <textarea
                  {...field("singleSourceReason")}
                  maxLength={2000}
                  rows={3}
                  placeholder="如因技术、兼容性等原因需单一来源采购，请说明具体原因"
                />
              </Field>
            </section>
          </div>
          <section className="panel purchase-section" id="purchase-attachments">
            <div className="purchase-bottom">
              <h2>附件上传</h2>
              <div className="purchase-upload">
                <Field name="attachmentQuote" label="附件所属报价">
                  <select
                    id="attachmentQuote"
                    value={uploadQuote}
                    onChange={(event) => setQuoteId(event.target.value)}
                    disabled={!savedQuotes.length}
                  >
                    <option value="" disabled>
                      先保存至少一条报价
                    </option>
                    {savedQuotes.map((quote) => (
                      <option key={quote.id} value={quote.id}>
                        报价 {form.quotes.indexOf(quote) + 1} ·{" "}
                        {quote.supplierName || "未命名供应商"}
                      </option>
                    ))}
                  </select>
                </Field>
                <div
                  className="upload-zone"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!busy && !blocked && uploadQuote) {
                      if (event.dataTransfer.files.length !== 1)
                        setError("请每次上传一个附件。");
                      else void upload(event.dataTransfer.files[0]);
                    }
                  }}
                >
                  <button
                    type="button"
                    className="text-button"
                    disabled={!uploadQuote}
                    onClick={() => inputFile.current?.click()}
                  >
                    <Icon name="upload" /> 点击上传 或拖拽文件到此处
                  </button>
                  <input
                    ref={inputFile}
                    type="file"
                    aria-label="选择报价附件"
                    accept=".jpg,.jpeg,.png,.pdf"
                    hidden
                    disabled={!uploadQuote}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void upload(file);
                    }}
                  />
                  <p className="hint">
                    JPEG、PNG、PDF，单件 ≤ 10 MiB；整单 {files.length}/9 件 ·{" "}
                    {fileSize(
                      files.reduce((sum, file) => sum + file.sizeBytes, 0),
                    )}
                    /50 MiB
                  </p>
                  {!uploadQuote && (
                    <p className="hint">先保存草稿及报价，再添加附件。</p>
                  )}
                </div>
              </div>
              <div className="actions">
                <button className="button secondary" type="submit">
                  {busy ? "处理中…" : "保存草稿"}
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={() => {
                    setError("");
                    if (!locked.current && !blocked && validate(true))
                      setConfirm("submit");
                  }}
                >
                  提交申请
                </button>
              </div>
            </div>
            {draft &&
              form.quotes
                .filter((quote) =>
                  files.some((file) => file.quoteId === quote.id),
                )
                .map((quote) => (
                  <div className="purchase-file-group" key={quote.id}>
                    <h3>
                      报价 {form.quotes.indexOf(quote) + 1} ·{" "}
                      {quote.supplierName || "未命名供应商"}
                    </h3>
                    <AttachmentItems
                      appId={draft.id}
                      resource="purchase-drafts"
                      items={files.filter((file) => file.quoteId === quote.id)}
                      onDelete={setConfirm}
                      disabled={busy || blocked}
                    />
                  </div>
                ))}
            <details className="purchase-remarks">
              <summary>补充备注（选填）</summary>
              <Field name="remarks" label="备注" error={errors.remarks}>
                <textarea {...field("remarks")} rows={2} maxLength={2000} />
              </Field>
            </details>
            <div className="section-heading">
              <p className="hint">
                * 为提交必填项，草稿可稍后补全。提交后表单与附件不可修改。
              </p>
              {draft && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setConfirm("draft")}
                >
                  删除草稿
                </button>
              )}
            </div>
          </section>
        </fieldset>
      </form>
      {confirm && (
        <TravelDialog
          title={
            confirm === "submit"
              ? "确认提交采购申请"
              : confirm === "draft"
                ? "确认删除草稿"
                : "确认删除附件"
          }
          close={() => setConfirm(null)}
          busy={busy}
        >
          <p>
            {confirm === "submit"
              ? "将保存当前内容并提交审批。提交后不能修改表单或附件。"
              : confirm === "draft"
                ? "将删除此草稿及其全部报价和附件，此操作不能撤销。"
                : `将删除附件“${confirm.originalName}”。`}
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
                <dt>预计总额</dt>
                <dd>{amounts.total} 元</dd>
              </div>
              <div>
                <dt>拟选供应商</dt>
                <dd>
                  {form.quotes.find((quote) => quote.selected)?.supplierName}
                </dd>
              </div>
              <div className="travel-span">
                <dt>审批路径</dt>
                <dd>部门负责人 → 企业负责人（实际人员提交时确定）</dd>
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
