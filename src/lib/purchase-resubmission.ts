import type { PurchaseRecord } from "./purchase";
export type PurchaseSuccessor = Pick<
  PurchaseRecord,
  "id" | "appNo" | "status" | "version"
>;
export type PurchaseResubmission = {
  sourceId: string;
  successor: PurchaseSuccessor | null;
};
export type PurchaseResubmissionResult = {
  sourceId: string;
  successor: PurchaseSuccessor;
  created: boolean;
};
