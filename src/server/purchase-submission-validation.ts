import type { PoolClient } from "pg";
import { z } from "zod";
import {
  purchaseDraftSchema,
  purchaseLineCents,
  type PurchaseRecord,
} from "../lib/purchase";
import { readAttachmentObject } from "./attachment-storage";
import {
  maxAttachments,
  maxApplicationAttachmentBytes,
} from "../lib/attachments";
import { ApiError } from "./errors";

// This validates only the fixed procurement form, not user-defined fields or rules.
export async function validatePurchaseSubmission(
  client: PoolClient,
  saved: PurchaseRecord,
) {
  const input = purchaseDraftSchema.parse({
    title: saved.title,
    reason: saved.reason,
    expectedDate: saved.expectedDate,
    project: saved.project,
    budgetLimit: saved.budgetLimit,
    selectionReason: saved.selectionReason,
    singleSource: saved.singleSource,
    singleSourceReason: saved.singleSourceReason,
    remarks: saved.remarks,
    items: saved.items.map(({ amount, ...item }) => {
      void amount;
      return item;
    }),
    quotes: saved.quotes,
  });
  const files = (
    await client.query<{
      id: string;
      quoteId: string;
      mimeType: string;
      storageKey: string;
      sizeBytes: number;
      sha256: string;
    }>(
      `SELECT id,supplier_quote_id AS "quoteId",mime_type AS "mimeType",
      storage_key AS "storageKey",size_bytes AS "sizeBytes",sha256
      FROM attachments WHERE app_id=$1 ORDER BY id`,
      [saved.id],
    )
  ).rows;
  const issues: z.core.$ZodIssue[] = [];
  const missing = (path: (string | number)[], message: string) =>
    issues.push({ code: "custom", path, message });
  for (const field of [
    "title",
    "reason",
    "expectedDate",
    "budgetLimit",
    "selectionReason",
  ] as const)
    if (!input[field]) missing([field], "提交时必须填写此项");
  if (!input.items.length) missing(["items"], "至少填写一条采购明细");
  let total = 0n;
  input.items.forEach((item, index) => {
    for (const field of [
      "name",
      "specification",
      "quantity",
      "unit",
      "unitPrice",
    ] as const)
      if (!item[field]) missing(["items", index, field], "采购明细必须完整");
    const amount = purchaseLineCents(item);
    if (amount === 0n)
      missing(["items", index], "明细金额四舍五入到分后必须大于零");
    total += amount ?? 0n;
  });
  const cents = (value: string) => BigInt(value.replace(".", ""));
  if (input.budgetLimit !== null && total > cents(input.budgetLimit))
    missing(["budgetLimit"], "预计采购总额不得超过预算上限");
  if (input.singleSource) {
    if (input.quotes.length !== 1)
      missing(["quotes"], "单一来源采购应填写一家供应商报价");
    if (!input.singleSourceReason)
      missing(["singleSourceReason"], "单一来源采购必须说明原因");
  } else if (input.quotes.length < 2)
    missing(["quotes"], "须提供至少两家报价，或声明单一来源及原因");
  const names = new Set<string>();
  input.quotes.forEach((quote, index) => {
    if (!quote.supplierName)
      missing(["quotes", index, "supplierName"], "须填写供应商名称");
    const name = quote.supplierName.normalize("NFKC").toLowerCase();
    if (names.has(name))
      missing(["quotes", index, "supplierName"], "供应商不能重复");
    names.add(name);
    if (!quote.quoteDate)
      missing(["quotes", index, "quoteDate"], "须填写报价日期");
    if (quote.amount === null && !quote.basis)
      missing(["quotes", index, "amount"], "须填写报价金额或明细说明");
    const attachments = files.filter((file) => file.quoteId === quote.id);
    if (!quote.basis && !attachments.length)
      missing(["quotes", index, "basis"], "须填写报价依据或上传报价附件");
    if (quote.isOnline) {
      if (!quote.purchaseUrl)
        missing(["quotes", index, "purchaseUrl"], "线上报价须提供购买链接");
      if (
        !attachments.some((file) =>
          ["image/png", "image/jpeg"].includes(file.mimeType),
        )
      )
        missing(["quotes", index], "线上报价须上传该报价的 JPEG/PNG 截图");
    }
  });
  const selected = input.quotes.filter((quote) => quote.selected);
  if (selected.length !== 1) missing(["quotes"], "必须选择一家供应商");
  if (
    selected[0]?.amount &&
    input.budgetLimit !== null &&
    cents(selected[0].amount) > cents(input.budgetLimit)
  )
    missing(["budgetLimit"], "拟选供应商报价不得超过预算上限");
  if (issues.length) throw new z.ZodError(issues);
  if (
    files.length > maxAttachments ||
    files.reduce((sum, file) => sum + file.sizeBytes, 0) >
      maxApplicationAttachmentBytes ||
    files.some(
      (file) => !input.quotes.some((quote) => quote.id === file.quoteId),
    )
  )
    throw new ApiError(
      409,
      "ATTACHMENT_INCONSISTENT",
      "报价附件关联或配额不一致，请核验后重试",
    );
  for (const file of files) await readAttachmentObject(file);
  const comparable = input.quotes.every((quote) => quote.amount !== null);
  const lowest = comparable
    ? input.quotes.reduce((best, quote) =>
        cents(quote.amount!) < cents(best.amount!) ? quote : best,
      ).amount
    : null;
  return {
    selectedQuoteId: selected[0].id!,
    selectedQuoteAmount: selected[0].amount,
    priceComparisonComplete: comparable,
    lowestQuoteAmount: lowest,
    selectedNotLowest:
      lowest === null ? null : cents(selected[0].amount!) > cents(lowest),
    attachmentEvidence: files.map(({ storageKey, ...file }) => {
      void storageKey;
      return file;
    }),
  };
}
