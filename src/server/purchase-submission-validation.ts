import type { PoolClient } from "pg";
import { z } from "zod";
import { purchaseDraftSchema, type PurchaseRecord } from "../lib/purchase";
import { readAttachmentObject } from "./attachment-storage";
import {
  maxAttachments,
  maxApplicationAttachmentBytes,
} from "../lib/attachments";
import { purchaseSubmissionIssues } from "../lib/purchase-submission";
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
  const issues = purchaseSubmissionIssues(input, files);
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
  const cents = (value: string) => BigInt(value.replace(".", ""));
  const selected = input.quotes.filter((quote) => quote.selected);
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
