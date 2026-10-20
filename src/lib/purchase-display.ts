import {
  purchaseDraftSchema,
  purchaseLineCents,
  type PurchaseDraft,
  type PurchaseDraftInput,
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
