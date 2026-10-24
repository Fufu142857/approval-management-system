"use client";
import { useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  handleSessionError,
  RequestError,
} from "@/lib/api-client";
import {
  reimbursementDecisionSchema,
  reimbursementWithdrawalSchema,
} from "@/lib/reimbursement-actions";
import type { ReimbursementDetail } from "@/lib/reimbursement-display";
import { TravelDialog } from "./travel-common";
import { Field, Notice } from "./ui";

type Action = "approve" | "reject" | "withdraw";
const labels = { approve: "通过", reject: "驳回", withdraw: "撤回" };
export function ReimbursementDecisionPanel({
  detail,
  viewerId,
  opinion,
  onOpinion,
  onBusy,
  onDone,
  reload,
}: {
  detail: ReimbursementDetail;
  viewerId: string;
  opinion: string;
  onOpinion: (value: string) => void;
  onBusy: (value: boolean) => void;
  onDone: (message: string) => void;
  reload: () => void;
}) {
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const app = detail.application;
  const own = app.applicantId === viewerId;
  const task = detail.tasks.find(
    (item) =>
      item.status === "pending" &&
      item.approverId === viewerId &&
      item.activatedAt &&
      detail.tasks.every(
        (previous) =>
          previous.seqNo >= item.seqNo || previous.status === "approved",
      ),
  );
  useEffect(() => {
    function leaving(event: BeforeUnloadEvent) {
      if (busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [busy]);
  if (app.status !== "pending" || (!own && !task)) return null;
  function validate(action: Action) {
    const input = { version: app.version, opinion };
    const parsed =
      action === "withdraw"
        ? reimbursementWithdrawalSchema.safeParse(input)
        : reimbursementDecisionSchema.safeParse({ ...input, decision: action });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0].message);
      document.getElementById("decision-opinion")?.focus();
      return false;
    }
    setFieldError("");
    return true;
  }
  function review(action: Action) {
    setError("");
    if (!busy && !blocked && validate(action)) setConfirm(action);
  }
  async function submit() {
    if (!confirm || locked.current || blocked || !validate(confirm)) return;
    locked.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await api<ReimbursementDetail>(
        confirm === "withdraw"
          ? `/reimbursement-applications/${app.id}/withdraw`
          : `/reimbursement-applications/${app.id}/tasks/${task!.id}/decision`,
        {
          method: "POST",
          body: JSON.stringify({
            version: app.version,
            opinion: opinion.trim(),
            ...(confirm === "withdraw" ? {} : { decision: confirm }),
          }),
        },
      );
      onDone(`${labels[confirm]}操作已完成。`);
    } catch (failure) {
      if (!handleSessionError(failure)) {
        setError(errorMessage(failure));
        if (
          failure instanceof RequestError &&
          (failure.status === 0 ||
            failure.status >= 500 ||
            failure.status === 409 ||
            failure.status === 404)
        )
          setBlocked(true);
      }
    } finally {
      locked.current = false;
      setBusy(false);
      onBusy(false);
      setConfirm(null);
    }
  }
  return (
    <section
      className="panel travel-section travel-decision"
      aria-label="申请操作"
    >
      <h2>{own ? "撤回申请" : `当前审批：${task!.name}`}</h2>
      <p className="hint">
        {own
          ? "审批中可撤回，未完成的待办将失效，已发生的审批记录会保留。"
          : "请核对申请内容与附件后操作；驳回必须填写理由。"}
      </p>
      {error && <Notice error>{error}</Notice>}
      {blocked && (
        <Notice error>
          状态或写入结果可能已变化，已暂停操作。意见仍保留，请先重新读取详情核对结果。
          <button className="text-button" onClick={reload}>
            重新读取详情
          </button>
        </Notice>
      )}
      <Field
        label={own ? "撤回说明（选填）" : "审批意见（驳回必填）"}
        name="decision-opinion"
        error={fieldError}
      >
        <textarea
          id="decision-opinion"
          rows={3}
          maxLength={2000}
          value={opinion}
          disabled={busy || blocked}
          aria-invalid={!!fieldError}
          aria-describedby={fieldError ? "decision-opinion-error" : undefined}
          onChange={(event) => onOpinion(event.target.value)}
        />
      </Field>
      <div className="actions">
        {own ? (
          <button
            className="button secondary"
            disabled={busy || blocked}
            onClick={() => review("withdraw")}
          >
            撤回申请
          </button>
        ) : (
          <>
            <button
              className="button"
              disabled={busy || blocked}
              onClick={() => review("approve")}
            >
              通过审批
            </button>
            <button
              className="button secondary"
              disabled={busy || blocked}
              onClick={() => review("reject")}
            >
              驳回申请
            </button>
          </>
        )}
      </div>
      {confirm && (
        <TravelDialog
          title={`确认${labels[confirm]}`}
          close={() => setConfirm(null)}
          busy={busy}
        >
          <p className="travel-long-text">
            {app.appNo} · {app.title}
          </p>
          <p>
            {confirm === "withdraw"
              ? "撤回后，本申请未完成的审批任务将失效。"
              : `本次处理第 ${task!.seqNo} 个节点：${task!.name}。`}
          </p>
          <p className="travel-long-text">{opinion.trim() || "未填写说明"}</p>
          <div className="actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              取消
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? "处理中…" : `确认${labels[confirm]}`}
            </button>
          </div>
        </TravelDialog>
      )}
    </section>
  );
}
