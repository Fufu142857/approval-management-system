"use client";
import { useRef, useState } from "react";
import type { UserIdentity } from "@/lib/identity";
import {
  type Department,
  type PageResult,
  roleNames,
} from "@/lib/identity-display";
import { useResource } from "./use-resource";
import { Notice, Pager, StatusBadge } from "./ui";
import { AccessEditor } from "./access-editor";

export function UsersPanel({
  currentUserId,
  departments,
}: {
  currentUserId: string;
  departments: Department[];
}) {
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<UserIdentity | null>(null);
  const [success, setSuccess] = useState("");
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const { data, error, loading, reload } = useResource<
    PageResult<UserIdentity>
  >(
    `/admin/users?page=${page}&pageSize=10${filter ? `&status=${filter}` : ""}`,
  );
  const department = (id: string | null) =>
    departments.find((item) => item.id === id)?.name ?? "待确认";
  function closeEditor() {
    setSelected(null);
    editorTrigger.current?.focus();
  }
  return (
    <div className="stack large-gap">
      {success && <Notice>{success}</Notice>}
      {selected && (
        <AccessEditor
          key={selected.id}
          user={selected}
          departments={departments}
          onCancel={closeEditor}
          onSaved={() => {
            closeEditor();
            setSuccess("权限已保存并记录审计，该用户需要重新登录。");
            reload();
          }}
        />
      )}
      <section className="panel table-panel" aria-label="用户列表">
        <div className="table-toolbar">
          <div className="filter">
            <label htmlFor="status-filter">状态筛选</label>
            <select
              id="status-filter"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setPage(1);
                closeEditor();
                setSuccess("");
              }}
            >
              <option value="">全部状态</option>
              <option value="pending">待确认</option>
              <option value="active">已启用</option>
              <option value="disabled">已停用</option>
            </select>
          </div>
          <button
            className="button secondary"
            onClick={reload}
            disabled={loading}
          >
            刷新列表
          </button>
        </div>
        {loading && (
          <p className="empty-state" role="status">
            正在加载用户…
          </p>
        )}
        {error && (
          <div className="stack padded">
            <Notice error>{error}</Notice>
            <button className="button secondary" onClick={reload}>
              重试
            </button>
          </div>
        )}
        {data && (
          <>
            <p className="scroll-hint">左右滑动可查看完整列表与管理操作</p>
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-label="可横向滚动的用户表格"
            >
              <table>
                <caption className="sr-only">组织成员与权限</caption>
                <thead>
                  <tr>
                    <th scope="col">成员</th>
                    <th scope="col">部门</th>
                    <th scope="col">角色</th>
                    <th scope="col">状态</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <strong>{user.fullName}</strong>
                        <small>@{user.username}</small>
                        <small className="email">{user.email}</small>
                      </td>
                      <td>
                        {department(user.departmentId)}
                        <small>
                          申请：{department(user.requestedDepartmentId)}
                        </small>
                      </td>
                      <td>
                        <div className="role-tags">
                          {user.roles.map((role) => (
                            <span className="role-tag" key={role}>
                              {roleNames[role]}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={user.status} />
                      </td>
                      <td>
                        {user.id === currentUserId ? (
                          <span className="hint">当前账号</span>
                        ) : (
                          <button
                            className="button secondary compact"
                            aria-label={`管理 ${user.username}`}
                            onClick={(event) => {
                              editorTrigger.current = event.currentTarget;
                              setSelected(user);
                              setSuccess("");
                            }}
                          >
                            管理
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.items.length && (
              <p className="empty-state">没有符合条件的用户</p>
            )}
            <Pager
              page={page}
              pageSize={data.pageSize}
              total={data.total}
              busy={loading}
              onChange={(value) => {
                setPage(value);
                closeEditor();
              }}
            />
          </>
        )}
      </section>
      <p className="hint">
        不能修改自己的部门、状态或角色。需要调整时，请由另一位管理员处理。
      </p>
    </div>
  );
}
