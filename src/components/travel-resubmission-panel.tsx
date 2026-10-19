"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, handleSessionError } from "@/lib/api-client";
import type {
  TravelResubmission,
  TravelResubmissionResult,
} from "@/lib/travel-resubmission";
import { travelStatusNames } from "@/lib/travel-display";
import { useResource } from "./use-resource";
import { TravelDialog } from "./travel-common";
import { Notice } from "./ui";

export function TravelResubmissionPanel({
  id,
  version,
  appNo,
  title,
  onBusy,
}: {
  id: string;
  version: number;
  appNo: string;
  title: string;
  onBusy: (busy: boolean) => void;
}) {
  const relation = useResource<TravelResubmission>(
    `/travel-applications/${id}/resubmission`,
  );
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const locked = useRef(false);
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
  async function copy() {
    if (locked.current || blocked || !relation.data || relation.data.successor)
      return;
    locked.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const result = await api<TravelResubmissionResult>(
        `/travel-applications/${id}/resubmission`,
        { method: "POST", body: JSON.stringify({ version }) },
      );
      setMessage(
        result.created
          ? "已创建关联原申请的新草稿，请编辑并确认后提交。"
          : "已有后续申请，请继续处理该记录。",
      );
      relation.reload();
    } catch (failure) {
      if (!handleSessionError(failure)) {
        setError(errorMessage(failure));
        setBlocked(true);
      }
    } finally {
      locked.current = false;
      setBusy(false);
      onBusy(false);
      setConfirm(false);
    }
  }
  function reload() {
    setBlocked(false);
    setError("");
    relation.reload();
  }
  const next = relation.data?.successor;
  return (
    <section className="panel travel-section" aria-label="复制重提">
      <h2>复制修改后重新提交</h2>
      <p className="hint">
        复制表单内容到新草稿，生成新编号并关联本申请。原审批历史与附件保留；新草稿不复制附件，请重新选择上传。
      </p>
      {message && <Notice>{message}</Notice>}
      {(error || relation.error) && (
        <Notice error>{error || relation.error}</Notice>
      )}
      {blocked && (
        <Notice error>
          复制结果需要核对，已暂停写入。请先查询后续申请，不要重复创建；版本冲突时刷新整份详情。
        </Notice>
      )}
      {relation.loading && <p role="status">正在查询后续申请…</p>}
      {next ? (
        <div className="actions">
          <span>
            {next.appNo} · {travelStatusNames[next.status]}
          </span>
          <Link
            className="button"
            prefetch={false}
            href={
              next.status === "draft"
                ? `/travel/drafts/${next.id}`
                : `/travel/applications/${next.id}`
            }
          >
            {next.status === "draft" ? "编辑重提草稿" : "查看后续申请"}
          </Link>
        </div>
      ) : (
        relation.data && (
          <button
            className="button"
            disabled={busy || blocked}
            onClick={() => setConfirm(true)}
          >
            复制为新草稿
          </button>
        )
      )}
      <button className="text-button" disabled={busy} onClick={reload}>
        核对复制结果
      </button>
      {confirm && (
        <TravelDialog
          title="确认复制重提"
          busy={busy}
          close={() => setConfirm(false)}
        >
          <p className="travel-long-text">
            {appNo} · {title}
          </p>
          <p>
            新草稿只复制差旅表单内容，不复制附件、审批人或审批记录。请重新核对日期、预算与附件，再按当前部门和审批规则提交。
          </p>
          <p className="hint">
            若另一窗口已复制，会返回已有后续申请；删除未提交的新草稿后可重新复制，已提交的后续记录不能被覆盖。
          </p>
          <div className="actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              取消
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => void copy()}
            >
              {busy ? "复制中…" : "确认复制"}
            </button>
          </div>
        </TravelDialog>
      )}
    </section>
  );
}
