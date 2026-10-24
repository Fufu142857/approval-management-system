import type { ReimbursementRecord } from "./reimbursement";
export type ReimbursementSuccessor = Pick<
  ReimbursementRecord,
  "id" | "appNo" | "status" | "version"
>;
export type ReimbursementResubmission = {
  sourceId: string;
  successor: ReimbursementSuccessor | null;
};
export type ReimbursementResubmissionResult = {
  sourceId: string;
  successor: ReimbursementSuccessor;
  created: boolean;
};
