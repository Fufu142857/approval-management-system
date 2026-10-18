import type { TravelApplication, TravelDraft } from "./travel";
import type { Attachment } from "./attachments";

export const travelStatusNames = {
  draft: "草稿",
  pending: "审批中",
  approved: "已通过",
  rejected: "已驳回",
  withdrawn: "已撤回",
};
export const taskStatusNames = {
  blocked: "未开始",
  pending: "待审批",
  approved: "已通过",
  rejected: "已驳回",
  cancelled: "已取消",
};
export type TravelAttachmentList = {
  items: Attachment[];
  totalBytes: number;
  version: number;
  status: keyof typeof travelStatusNames;
};
type SnapshotPerson = {
  id: string;
  name: string;
  departmentId: string;
  departmentName: string;
};
// HTTP representation of the existing fixed travel snapshot, not a configurable workflow.
export type TravelDetail = {
  application: TravelApplication;
  workflow: {
    id: string;
    ruleVersion: string;
    submittedVersion: number;
    createdAt: string;
    routeSnapshot: {
      applicant: SnapshotPerson;
      policy: string;
      steps: { seqNo: number; name: string; approver: SnapshotPerson }[];
    };
  };
  tasks: {
    id: string;
    seqNo: number;
    name: string;
    approverId: string;
    status: keyof typeof taskStatusNames;
    activatedAt: string | null;
    finishedAt: string | null;
  }[];
  logs: {
    id: string;
    actorId: string;
    action: "submitted" | "approved" | "rejected" | "withdrawn";
    opinion: string;
    result: TravelApplication["status"];
    applicationVersion: number;
    createdAt: string;
  }[];
};
export const travelTime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
export const fileSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
export function travelFields(draft?: TravelDraft) {
  return {
    title: draft?.title ?? "",
    departure: draft?.departure ?? "",
    destination: draft?.destination ?? "",
    startDate: draft?.startDate ?? "",
    endDate: draft?.endDate ?? "",
    purpose: draft?.purpose ?? "",
    companions: draft?.companions ?? "",
    transportation: draft?.transportation ?? "",
    budget: draft?.budget ?? "",
    remarks: draft?.remarks ?? "",
  };
}
