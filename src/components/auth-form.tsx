"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { loginSchema, registerSchema } from "@/lib/identity";
import type { Department } from "@/lib/identity-display";
import { api, errorMessage } from "@/lib/api-client";
import { Field, Notice } from "./ui";
const hints: Record<string, string> = {
  username: "3–32 位，以英文字母开头，仅使用字母、数字和下划线。",
  fullName: "请填写姓名，最多 80 个字符。",
  email: "请填写有效邮箱，最多 254 个字符。",
  password: "密码需为 8–128 个字符。",
  requestedDepartmentId: "请选择申请加入的部门。",
};
export function AuthForm({
  mode,
  departments = [],
  expired = false,
}: {
  mode: "login" | "register";
  departments?: Department[];
  expired?: boolean;
}) {
  const registering = mode === "register";
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const parsed = (registering ? registerSchema : loginSchema).safeParse(
      Object.fromEntries(new FormData(form)),
    );
    setMessage("");
    if (!parsed.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const name = String(issue.path[0]);
        nextErrors[name] = hints[name] ?? "请检查输入。";
      }
      setErrors(nextErrors);
      (
        form.elements.namedItem(
          Object.keys(nextErrors)[0],
        ) as HTMLElement | null
      )?.focus();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      form.reset();
      if (registering) setRegistered(true);
      else window.location.replace("/account");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  function a11y(name: string) {
    return {
      "aria-invalid": !!errors[name],
      "aria-describedby": errors[name] ? `${name}-error` : undefined,
    };
  }
  if (registered)
    return (
      <div className="stack">
        <div className="success-icon" aria-hidden="true">
          ✓
        </div>
        <h1>账号已创建</h1>
        <p className="muted">
          你现在可以登录查看个人信息。部门与权限将在管理员确认后生效。
        </p>
        <Link className="button" href="/login">
          前往登录
        </Link>
      </div>
    );
  return (
    <div className="stack">
      <div>
        <p className="eyebrow">{registering ? "加入组织" : "欢迎回来"}</p>
        <h1>{registering ? "创建你的账号" : "登录审批管理系统"}</h1>
        <p className="muted">
          {registering
            ? "填写真实资料，提交后等待管理员确认。"
            : "使用你的账号，查看身份与组织权限。"}
        </p>
      </div>
      {expired && (
        <Notice>
          会话已失效或尚未登录，请重新登录。如果管理员刚调整了你的权限，也需要重新登录。
        </Notice>
      )}
      {message && <Notice error>{message}</Notice>}
      <noscript>
        <p className="notice">请启用 JavaScript 后使用账号功能。</p>
      </noscript>
      <form
        method="post"
        onSubmit={submit}
        noValidate
        className="stack"
        aria-busy={busy}
      >
        <Field
          label="用户名"
          name="username"
          error={errors.username}
          hint={registering ? "3–32 位，字母开头，可含数字与下划线" : undefined}
        >
          <input
            id="username"
            name="username"
            autoComplete="username"
            maxLength={32}
            required
            {...a11y("username")}
          />
        </Field>
        {registering && (
          <>
            <Field label="姓名" name="fullName" error={errors.fullName}>
              <input
                id="fullName"
                name="fullName"
                autoComplete="name"
                maxLength={80}
                required
                {...a11y("fullName")}
              />
            </Field>
            <Field label="邮箱" name="email" error={errors.email}>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                required
                {...a11y("email")}
              />
            </Field>
          </>
        )}
        <Field
          label="密码"
          name="password"
          error={errors.password}
          hint={
            registering ? "8–128 个字符，请勿与其他账号共用密码" : undefined
          }
        >
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={registering ? "new-password" : "current-password"}
            maxLength={128}
            required
            {...a11y("password")}
          />
        </Field>
        {registering && (
          <Field
            label="申请部门"
            name="requestedDepartmentId"
            error={errors.requestedDepartmentId}
            hint="最终归属由管理员确认，你无需选择角色。"
          >
            <select
              id="requestedDepartmentId"
              name="requestedDepartmentId"
              defaultValue=""
              required
              {...a11y("requestedDepartmentId")}
            >
              <option value="" disabled>
                请选择部门
              </option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {registering && !departments.length && (
          <Notice error>暂无可申请的部门，请联系管理员后重试。</Notice>
        )}
        <button
          className="button wide"
          disabled={busy || (registering && !departments.length)}
        >
          {busy ? "正在提交…" : registering ? "创建账号" : "登录"}
        </button>
      </form>
      <p className="auth-switch">
        {registering ? "已有账号？" : "还没有账号？"}{" "}
        <Link href={registering ? "/login" : "/register"}>
          {registering ? "返回登录" : "注册账号"} →
        </Link>
      </p>
    </div>
  );
}
