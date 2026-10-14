export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(15000),
    });
  } catch {
    throw new RequestError(0, "网络连接失败或请求超时，请检查连接后重试。");
  }
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new RequestError(
      response.status,
      result?.error?.message ?? "请求失败，请稍后重试。",
    );
  if (!result || !("data" in result))
    throw new RequestError(500, "服务响应异常，请稍后重试。");
  return result.data as T;
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}
export function handleSessionError(error: unknown) {
  if (error instanceof RequestError && error.status === 401) {
    window.location.replace("/login?expired=1");
    return true;
  }
  if (error instanceof RequestError && error.status === 403) {
    window.location.replace("/account?denied=1");
    return true;
  }
  return false;
}
