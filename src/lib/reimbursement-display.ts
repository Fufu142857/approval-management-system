import {
  reimbursementDraftSchema,
  type ReimbursementDraft,
  type ReimbursementDraftInput,
} from "./reimbursement";

export const reimbursementCategoryNames = {
  transport: "交通",
  lodging: "住宿",
  meals: "餐饮",
  office: "办公",
  other: "其他",
} as const;

// Explicit fixed input fields only: never PUT server-owned identities, totals or source summaries.
export function reimbursementFields(
  draft?: ReimbursementDraft,
): ReimbursementDraftInput {
  if (!draft) return reimbursementDraftSchema.parse({});
  return {
    title: draft.title,
    description: draft.description,
    independentReason: draft.independentReason,
    remarks: draft.remarks,
    linkedApplicationIds: [...draft.linkedApplicationIds],
    items: draft.items.map(
      ({
        id,
        category,
        expenseDate,
        purpose,
        amount,
        noReceipt,
        noReceiptReason,
      }) => ({
        id,
        category,
        expenseDate,
        purpose,
        amount,
        noReceipt,
        noReceiptReason,
      }),
    ),
  };
}
export function reimbursementAmount(items: ReimbursementDraftInput["items"]) {
  let cents = 0n;
  let complete = items.length > 0;
  for (const item of items) {
    const parsed = reimbursementDraftSchema.safeParse({
      items: [{ amount: item.amount }],
    });
    const value = parsed.success ? parsed.data.items[0].amount : null;
    if (value === null) complete = false;
    else cents += BigInt(value.replace(".", ""));
  }
  return {
    total: complete
      ? `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`
      : null,
    overflow: cents > 99999999999999n,
  };
}
