import type { PoolClient } from "pg";
import { z } from "zod";
import {
  reimbursementDraftSchema,
  type ReimbursementRecord,
} from "../lib/reimbursement";
import { receiptNumberSchema } from "../lib/reimbursement-attachments";
import { reimbursementSubmissionIssues } from "../lib/reimbursement-submission";
import {
  maxAttachments,
  maxApplicationAttachmentBytes,
} from "../lib/attachments";
import { readAttachmentObject } from "./attachment-storage";
import { ApiError } from "./errors";

export async function validateReimbursementSubmission(
  client: PoolClient,
  saved: ReimbursementRecord,
) {
  const input = reimbursementDraftSchema.parse({
    title: saved.title,
    description: saved.description,
    independentReason: saved.independentReason,
    remarks: saved.remarks,
    linkedApplicationIds: saved.linkedApplicationIds,
    items: saved.items,
  });
  const files = (
    await client.query<{
      id: string;
      itemId: string;
      receiptNumber: string;
      mimeType: string;
      storageKey: string;
      sizeBytes: number;
      sha256: string;
    }>(
      `SELECT id,reimbursement_item_id AS "itemId",receipt_number AS "receiptNumber",mime_type AS "mimeType",
      storage_key AS "storageKey",size_bytes AS "sizeBytes",sha256 FROM attachments WHERE app_id=$1 ORDER BY id`,
      [saved.id],
    )
  ).rows;
  const issues = reimbursementSubmissionIssues(input, files);
  if (issues.length) throw new z.ZodError(issues);
  if (
    files.length > maxAttachments ||
    files.reduce((sum, file) => sum + file.sizeBytes, 0) >
      maxApplicationAttachmentBytes ||
    new Set(files.map((file) => file.id)).size !== files.length ||
    files.some((file) => !input.items.some((item) => item.id === file.itemId))
  )
    throw new ApiError(
      409,
      "ATTACHMENT_INCONSISTENT",
      "票据关联或配额不一致，请核验后重试",
    );
  for (const file of files) {
    receiptNumberSchema.parse(file.receiptNumber);
    await readAttachmentObject(file);
  }
  const cents = input.items.reduce(
    (sum, item) => sum + BigInt(item.amount!.replace(".", "")),
    0n,
  );
  const totalAmount = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
  if (saved.totalAmount !== totalAmount)
    throw new ApiError(
      409,
      "AMOUNT_INCONSISTENT",
      "费用合计不一致，请重新核验",
    );
  return {
    totalAmount,
    noReceiptItems: input.items
      .filter((item) => item.noReceipt)
      .map((item) => ({ id: item.id!, reason: item.noReceiptReason })),
    attachmentEvidence: files.map(({ storageKey, ...file }) => {
      void storageKey;
      return file;
    }),
  };
}
