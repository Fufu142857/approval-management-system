"use client";
import Link from "next/link";
import { useState } from "react";
import { Notice } from "./ui";
import { TravelDecisionPanel } from "./travel-decision-panel";
import {
  travelStatusNames,
  taskStatusNames,
  travelTime,
  type TravelDetail as Detail,
  type TravelAttachmentList,
} from "@/lib/travel-display";
import { useResource } from "./use-resource";
import { AttachmentItems, TravelFailure } from "./travel-common";

export function TravelDetail({
  id,
  viewerId,
}: {
  id: string;
  viewerId: string;
}) {
  const [opinion, setOpinion] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const detail = useResource<Detail>(`/travel-applications/${id}`);
  const files = useResource<TravelAttachmentList>(
    `/travel-applications/${id}/attachments`,
  );
  const reload = () => {
    detail.reload();
    files.reload();
  };
  if (detail.error || files.error)
    return (
      <div className="stack">
        <TravelFailure message={detail.error || files.error!} retry={reload} />
        <Link href="/travel/applications">返回我的申请</Link>
        <Link href="/travel/tasks">返回我的待办</Link>
      </div>
    );
  if (!detail.data || !files.data)
    return (
      <div className="stack">
        {message && <Notice>{message}</Notice>}
        <p className="empty-state" role="status">
          正在加载差旅申请…
        </p>
      </div>
    );
  const { application: app, workflow, tasks, logs } = detail.data;
  if (app.version !== files.data.version)
    return (
      <TravelFailure
        message="读取期间申请状态已变化，请刷新后查看。"
        retry={reload}
      />
    );
  const snapshot = workflow.routeSnapshot;
  const actor = (id: string) =>
    id === snapshot.applicant.id
      ? snapshot.applicant.name
      : (snapshot.steps.find((step) => step.approver.id === id)?.approver
          .name ?? "历史操作人");
  return (
    <div className="stack travel-workspace">
      {message && <Notice>{message}</Notice>}
      <div className="section-heading">
        <Link
          className="text-button"
          href={
            app.applicantId === viewerId
              ? "/travel/applications"
              : "/travel/tasks"
          }
        >
          {app.applicantId === viewerId ? "← 返回我的申请" : "← 返回我的待办"}
        </Link>
        <button className="button secondary" disabled={busy} onClick={reload}>
          刷新详情
        </button>
      </div>
      <section className="panel travel-section">
        <div className="section-heading">
          <h2 className="travel-long-text">{app.title}</h2>
          <span className="badge">{travelStatusNames[app.status]}</span>
        </div>
        <p className="hint">
          {app.appNo} · 提交于 {travelTime(app.submittedAt)}
        </p>
        <p className="hint">
          申请已提交，表单与附件只读；审批与撤回操作按当前权限开放。
        </p>
        <dl className="travel-details">
          <div>
            <dt>申请人</dt>
            <dd>{snapshot.applicant.name}</dd>
          </div>
          <div>
            <dt>申请部门</dt>
            <dd>{snapshot.applicant.departmentName}</dd>
          </div>
          <div className="travel-span">
            <dt>出差目的</dt>
            <dd>{app.purpose}</dd>
          </div>
          <div>
            <dt>出发地点</dt>
            <dd>{app.departure}</dd>
          </div>
          <div>
            <dt>目的地</dt>
            <dd>{app.destination}</dd>
          </div>
          <div>
            <dt>开始日期</dt>
            <dd>{app.startDate}</dd>
          </div>
          <div>
            <dt>结束日期</dt>
            <dd>{app.endDate}</dd>
          </div>
          <div>
            <dt>出差天数</dt>
            <dd>{app.durationDays} 天（自然日，含首尾）</dd>
          </div>
          <div>
            <dt>交通方式</dt>
            <dd>{app.transportation}</dd>
          </div>
          <div>
            <dt>同行人员</dt>
            <dd>{app.companions || "—"}</dd>
          </div>
          <div>
            <dt>费用预算</dt>
            <dd>{app.budget} 元</dd>
          </div>
          <div className="travel-span">
            <dt>备注</dt>
            <dd>{app.remarks || "—"}</dd>
          </div>
        </dl>
      </section>
      <section className="panel travel-section">
        <h2>审批进度</h2>
        <ol className="travel-timeline">
          {tasks.map((task) => (
            <li key={task.id}>
              <div className="section-heading">
                <strong>
                  {task.seqNo}. {task.name} · {actor(task.approverId)}
                </strong>
                <span className="badge">{taskStatusNames[task.status]}</span>
              </div>
              <p className="hint">
                {task.finishedAt
                  ? `处理时间：${travelTime(task.finishedAt)}`
                  : task.activatedAt
                    ? `开始时间：${travelTime(task.activatedAt)}`
                    : "前一节点通过后开始"}
              </p>
            </li>
          ))}
        </ol>
      </section>
      <section className="panel travel-section">
        <h2>补充附件</h2>
        <AttachmentItems appId={id} items={files.data.items} disabled={busy} />
      </section>
      <TravelDecisionPanel
        detail={detail.data}
        viewerId={viewerId}
        opinion={opinion}
        onOpinion={setOpinion}
        onBusy={setBusy}
        reload={reload}
        onDone={(value) => {
          setOpinion("");
          setMessage(value);
          reload();
        }}
      />
      <section className="panel travel-section">
        <h2>历史记录</h2>
        <ol className="travel-timeline">
          {logs.map((log) => (
            <li key={log.id}>
              <div className="section-heading">
                <strong>
                  {actor(log.actorId)} ·{" "}
                  {log.action === "submitted"
                    ? "提交申请"
                    : log.action === "approved"
                      ? "批准"
                      : log.action === "rejected"
                        ? "驳回"
                        : "撤回"}
                </strong>
                <time>{travelTime(log.createdAt)}</time>
              </div>
              <p className="hint">
                处理结果：{travelStatusNames[log.result]} · 申请版本{" "}
                {log.applicationVersion}
              </p>
              {log.opinion && <p className="travel-long-text">{log.opinion}</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
