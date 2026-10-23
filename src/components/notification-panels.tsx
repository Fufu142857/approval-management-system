"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type {
  NotificationItem,
  NotificationListInput,
} from "@/lib/notifications";
import { api, errorMessage, handleSessionError } from "@/lib/api-client";
import {
  taskStatusNames,
  travelStatusNames,
  travelTime,
} from "@/lib/travel-display";
import { useForegroundResource } from "./use-foreground-resource";
import { useNotifications } from "./notification-context";
import { Notice, Pager } from "./ui";

const kindNames: Record<NotificationItem["kind"], string> = {
  "approval.pending": "新待办",
  "application.approved": "申请通过",
  "application.rejected": "申请驳回",
  "application.withdrawn": "申请撤回",
};
type NotificationList = {
  items: NotificationItem[];
  total: number;
  unreadCount: number;
  page: number;
  pageSize: number;
};
function useMarkRead(reload: () => void) {
  const { enabled, refreshCount } = useNotifications();
  const [busyId, setBusyId] = useState<string>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [enabled],
  );
  async function mark(id: string) {
    if (!enabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusyId(id);
    setError("");
    setMessage("");
    try {
      await api(`/notifications/${id}/read`, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
      });
      if (!controller.signal.aborted) setMessage("已标记为已读。");
    } catch (failure) {
      if (!controller.signal.aborted && !handleSessionError(failure))
        setError(
          `${errorMessage(failure)} 已重新查询阅读状态，请核对后再操作。`,
        );
    } finally {
      setBusyId(undefined);
      if (!controller.signal.aborted) {
        reload();
        refreshCount();
      }
      if (request.current === controller) request.current = null;
    }
  }
  return { busyId, message, error, mark };
}
function CurrentState({ item }: { item: NotificationItem }) {
  return item.target ? (
    <>
      <span>
        申请当前状态：
        {travelStatusNames[
          item.target.status as keyof typeof travelStatusNames
        ] ?? item.target.status}
      </span>
      {item.task && (
        <span className="hint">
          原任务当前状态：
          {taskStatusNames[item.task.status as keyof typeof taskStatusNames] ??
            item.task.status}
        </span>
      )}
    </>
  ) : (
    <span className="hint">关联申请当前不可访问</span>
  );
}
function PollStatus({
  updatedAt,
  error,
  refresh,
}: {
  updatedAt?: string;
  error?: string;
  refresh: () => void;
}) {
  return (
    <>
      <p className="hint">
        页面可见时每 30 秒自动更新，返回前台立即更新。
        {updatedAt && `最近更新：${travelTime(updatedAt)}。`}
      </p>
      {error && (
        <Notice error>
          {error} {updatedAt && "下方为上次成功获取的数据。"}
          <button className="text-button" onClick={refresh}>
            重新加载
          </button>
        </Notice>
      )}
    </>
  );
}
export function NotificationListPanel({
  input,
}: {
  input: NotificationListInput;
}) {
  const { enabled, refreshCount } = useNotifications();
  useEffect(() => {
    refreshCount();
  }, [refreshCount]);
  const router = useRouter();
  const [navigating, startTransition] = useTransition();
  const params = new URLSearchParams({
    state: input.state,
    page: String(input.page),
    pageSize: String(input.pageSize),
  });
  const resource = useForegroundResource<NotificationList>(
    `/notifications?${params}`,
    enabled,
  );
  const read = useMarkRead(resource.refresh);
  const data = resource.data;
  function go(state: string, page = 1) {
    startTransition(() =>
      router.push(
        `/notifications?${new URLSearchParams({ state, page: String(page), pageSize: String(input.pageSize) })}`,
        { scroll: false },
      ),
    );
  }
  const busy = !!read.busyId || navigating || !enabled;
  return (
    <div className="stack">
      <nav className="management-tabs" aria-label="通知筛选">
        {(
          [
            ["all", "全部通知"],
            ["unread", "未读通知"],
            ["read", "已读通知"],
          ] as const
        ).map(([state, label]) => (
          <button
            key={state}
            className="text-button"
            aria-current={input.state === state ? "page" : undefined}
            disabled={busy}
            onClick={() => go(state)}
          >
            {label}
          </button>
        ))}
      </nav>
      <section className="panel notification-panel" aria-label="通知列表">
        <div className="section-heading">
          <div>
            <h2>站内通知</h2>
            <p className="hint">
              本人全部未读：{data ? data.unreadCount : "—"}
            </p>
          </div>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => {
              resource.refresh();
              refreshCount();
            }}
          >
            刷新通知
          </button>
        </div>
        <PollStatus {...resource} />
        {read.message && <Notice>{read.message}</Notice>}
        {read.error && <Notice error>{read.error}</Notice>}
        {!data && !resource.error && <p role="status">正在加载通知…</p>}
        {data && (
          <>
            {data.items.length ? (
              <ul className="notification-list">
                {data.items.map((item) => (
                  <li key={item.id} className="notification-item">
                    <div className="notification-body">
                      <div className="notification-meta">
                        <span className="badge">
                          {item.readAt ? "已读" : "未读"}
                        </span>
                        <span>{kindNames[item.kind]}</span>
                        <time dateTime={item.createdAt}>
                          {travelTime(item.createdAt)}
                        </time>
                      </div>
                      <h3>
                        <Link
                          href={`/notifications/${item.id}`}
                          prefetch={false}
                        >
                          {item.title}
                        </Link>
                      </h3>
                      <div className="notification-state">
                        <CurrentState item={item} />
                      </div>
                    </div>
                    <div className="actions">
                      <Link href={`/notifications/${item.id}`} prefetch={false}>
                        查看通知
                      </Link>
                      {!item.readAt && (
                        <button
                          className="button secondary"
                          disabled={busy || !!resource.error}
                          onClick={() => void read.mark(item.id)}
                        >
                          {read.busyId === item.id ? "标记中…" : "标记已读"}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-state">
                <p>没有符合条件的通知</p>
                {input.page > 1 && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => go(input.state)}
                  >
                    返回第一页
                  </button>
                )}
              </div>
            )}
            <Pager
              page={input.page}
              pageSize={input.pageSize}
              total={data.total}
              busy={busy}
              onChange={(page) => go(input.state, page)}
            />
          </>
        )}
      </section>
    </div>
  );
}
export function NotificationDetailPanel({ id }: { id: string }) {
  const { enabled, refreshCount } = useNotifications();
  useEffect(() => {
    refreshCount();
  }, [refreshCount]);
  const resource = useForegroundResource<NotificationItem>(
    `/notifications/${id}`,
    enabled,
  );
  const read = useMarkRead(resource.refresh);
  const item = resource.data;
  return (
    <div className="stack">
      <div className="section-heading">
        <Link href="/notifications" prefetch={false}>
          ← 返回通知中心
        </Link>
        <button
          className="button secondary"
          disabled={!!read.busyId || !enabled}
          onClick={() => {
            resource.refresh();
            refreshCount();
          }}
        >
          刷新通知
        </button>
      </div>
      <section className="panel notification-panel" aria-label="通知详情">
        <PollStatus {...resource} />
        {read.message && <Notice>{read.message}</Notice>}
        {read.error && <Notice error>{read.error}</Notice>}
        {!item && !resource.error && <p role="status">正在加载通知…</p>}
        {item && (
          <>
            <div className="notification-meta">
              <span className="badge">{item.readAt ? "已读" : "未读"}</span>
              <span>{kindNames[item.kind]}</span>
            </div>
            <h2 className="notification-title">{item.title}</h2>
            <p className="hint">
              收到时间：{travelTime(item.createdAt)}
              {item.readAt && ` · 首次已读：${travelTime(item.readAt)}`}
            </p>
            <div className="notification-state">
              <CurrentState item={item} />
            </div>
            <p className="hint">
              通知记录发生时的事件；申请和原任务状态会随流程变化。进入申请后按最新状态与权限操作。
            </p>
            <div className="actions">
              {item.target &&
                ["travel", "purchase", "reimbursement"].includes(
                  item.target.type,
                ) &&
                !resource.error && (
                  <Link
                    className="button"
                    prefetch={false}
                    href={`/${item.target.type}/applications/${item.target.id}`}
                  >
                    查看申请详情
                  </Link>
                )}
              {!item.readAt && (
                <button
                  className="button secondary"
                  disabled={!!read.busyId || !enabled || !!resource.error}
                  onClick={() => void read.mark(item.id)}
                >
                  {read.busyId ? "标记中…" : "标记已读"}
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
