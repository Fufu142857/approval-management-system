import { z } from "zod";
import { sessionSeconds } from "./auth";
import { ApiError } from "./errors";

export const cookieName = "approval_session";

export function sessionCookie(token: string, clear = false) {
  const secure = process.env.SESSION_COOKIE_SECURE === "true";
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : sessionSeconds}${secure ? "; Secure" : ""}`;
}

export function requestToken(request: Request) {
  const bearer = request.headers.get("authorization");
  if (bearer !== null) {
    if (!/^Bearer [a-f0-9]{64}$/.test(bearer))
      throw new ApiError(401, "UNAUTHENTICATED", "会话凭据无效");
    return bearer.slice(7);
  }
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
}

export function checkOrigin(request: Request, publicEndpoint = false) {
  const origin = request.headers.get("origin");
  const expected = process.env.APP_ORIGIN;
  if (!expected) throw new Error("APP_ORIGIN is required");
  if (origin && origin !== expected)
    throw new ApiError(403, "INVALID_ORIGIN", "请求来源不被允许");
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new ApiError(403, "INVALID_ORIGIN", "请求来源不被允许");
  // Cookie writes require Origin. Native clients explicitly supply Bearer credentials.
  if (!origin && !publicEndpoint && !request.headers.has("authorization")) {
    throw new ApiError(
      403,
      "INVALID_ORIGIN",
      "Cookie 写请求必须携带同源 Origin",
    );
  }
}

export async function jsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  ) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "请使用 application/json",
    );
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_JSON", "请求正文不能为空");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new ApiError(413, "PAYLOAD_TOO_LARGE", "请求正文超过 16 KiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求正文不是有效 JSON");
  }
  return schema.parse(input);
}

export function data(value: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(
    { data: value },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

export async function endpoint(
  work: () => Promise<Response>,
): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    let failure: {
      code: string;
      message: string;
      fieldErrors?: Record<string, string[]>;
    };
    let status: number;
    if (error instanceof z.ZodError) {
      status = 400;
      failure = {
        code: "VALIDATION_ERROR",
        message: "输入字段不符合要求",
        fieldErrors: z.flattenError(error).fieldErrors as Record<
          string,
          string[]
        >,
      };
    } else if (error instanceof ApiError) {
      status = error.status;
      failure = { code: error.code, message: error.message };
    } else if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      status = 409;
      failure = { code: "ALREADY_EXISTS", message: "用户名或邮箱已存在" };
    } else {
      status = 500;
      failure = {
        code: "INTERNAL_ERROR",
        message: "服务暂时不可用，请稍后重试",
      };
      // Do not log request data, credentials or database exception details.
      console.error(
        "API request failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
    return Response.json(
      { error: failure },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
