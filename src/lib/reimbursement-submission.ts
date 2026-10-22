import type { z } from "zod";
import type { ReimbursementDraftInput } from "./reimbursement";

// Fixed reimbursement fields only; input must first pass reimbursementDraftSchema.
export function reimbursementSubmissionIssues(
  input: ReimbursementDraftInput,
  files: readonly { itemId: string }[],
): z.core.$ZodIssue[] {
  const issues: z.core.$ZodIssue[] = [];
  const missing = (path: (string | number)[], message: string) =>
    issues.push({ code: "custom", path, message });
  for (const field of ["title", "description"] as const)
    if (!input[field]) missing([field], "提交时必须填写此项");
  if (!input.linkedApplicationIds.length && !input.independentReason)
    missing(["independentReason"], "独立报销须填写说明");
  if (!input.items.length) missing(["items"], "至少填写一条费用明细");
  input.items.forEach((item, index) => {
    for (const field of [
      "category",
      "expenseDate",
      "purpose",
      "amount",
    ] as const)
      if (!item[field]) missing(["items", index, field], "费用明细必须完整");
    if (item.noReceipt) {
      if (!item.noReceiptReason)
        missing(["items", index, "noReceiptReason"], "无票支出须说明原因");
    } else if (!files.some((file) => file.itemId === item.id)) {
      missing(["items", index], "请上传本明细票据，或明确选择无票并说明原因");
    }
  });
  return issues;
}
