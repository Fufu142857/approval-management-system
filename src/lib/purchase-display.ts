import {
  purchaseDraftSchema,
  purchaseLineCents,
  type PurchaseDraft,
  type PurchaseDraftInput,
  type PurchaseRecord,
} from "./purchase";

// Only fixed purchase input fields cross the PUT boundary; omit derived amounts and metadata.
export function purchaseFields(draft?: PurchaseDraft): PurchaseDraftInput {
  if (!draft) return purchaseDraftSchema.parse({});
  return {
    title: draft.title,
    reason: draft.reason,
    expectedDate: draft.expectedDate,
    project: draft.project,
    budgetLimit: draft.budgetLimit,
    selectionReason: draft.selectionReason,
    singleSource: draft.singleSource,
    singleSourceReason: draft.singleSourceReason,
    remarks: draft.remarks,
    items: draft.items.map(
      ({ id, name, specification, quantity, unit, unitPrice }) => ({
        id,
        name,
        specification,
        quantity,
        unit,
        unitPrice,
      }),
    ),
    quotes: draft.quotes.map((quote) => ({ ...quote })),
  };
}
export function purchaseAmounts(items: PurchaseDraftInput["items"]) {
  // Validate/normalize each raw row before integer arithmetic, even during incomplete typing.
  const cents = items.map((item) => {
    const parsed = purchaseDraftSchema.safeParse({ items: [item] });
    return parsed.success ? purchaseLineCents(parsed.data.items[0]) : null;
  });
  const format = (value: bigint | null) =>
    value === null
      ? null
      : `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
  const total =
    cents.length && cents.every((value) => value !== null)
      ? cents.reduce<bigint>((sum, value) => sum + value!, 0n)
      : null;
  return {
    lines: cents.map(format),
    total: format(total),
    overflow: total !== null && total > 99999999999999n,
  };
}

// HTTP representation of the existing fixed purchase workflow, not a configurable template.
type SnapshotPerson = {
  id: string;
  name: string;
  departmentId: string;
  departmentName: string;
};
export type PurchaseDetail = {
  application: Omit<PurchaseRecord, "status" | "submittedAt"> & {
    status: "pending" | "approved" | "rejected" | "withdrawn";
    submittedAt: string;
  };
  workflow: {
    id: string;
    ruleVersion: string;
    submittedVersion: number;
    createdAt: string;
    routeSnapshot: {
      ruleVersion: string;
      policy: string;
      applicant: SnapshotPerson;
      budgetLimit: string;
      totalAmount: string;
      selectionReason: string;
      singleSource: boolean;
      singleSourceReason: string;
      selectedQuoteId: string;
      selectedQuoteAmount: string | null;
      priceComparisonComplete: boolean;
      lowestQuoteAmount: string | null;
      selectedNotLowest: boolean | null;
      attachmentEvidence: {
        id: string;
        quoteId: string;
        mimeType: string;
        sizeBytes: number;
        sha256: string;
      }[];
      steps: {
        seqNo: number;
        name: string;
        rule: string;
        approver: SnapshotPerson;
      }[];
    };
  };
  tasks: {
    id: string;
    seqNo: number;
    name: string;
    approverId: string;
    status: "blocked" | "pending" | "approved" | "rejected" | "cancelled";
    createdAt: string;
    activatedAt: string | null;
    finishedAt: string | null;
  }[];
  logs: {
    id: string;
    taskId: string | null;
    actorId: string;
    action: "submitted" | "approved" | "rejected" | "withdrawn";
    opinion: string;
    result: "pending" | "approved" | "rejected" | "withdrawn";
    applicationVersion: number;
    createdAt: string;
  }[];
};
export function purchaseLink(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
