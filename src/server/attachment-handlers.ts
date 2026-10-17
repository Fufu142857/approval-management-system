import { z } from "zod";
import {
  attachmentContentQuery,
  emptyAttachmentQuery,
  maxAttachmentBytes,
} from "../lib/attachments";
import { draftVersionSchema } from "../lib/travel";
import { ApiError } from "./errors";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";
import {
  authorizeAttachmentUpload,
  uploadTravelAttachment,
  listTravelAttachments,
  deleteTravelAttachment,
  getTravelAttachmentContent,
} from "./travel-attachments";

type Context = { params: Promise<{ id: string; attachmentId?: string }> };
const query = (request: Request) =>
  Object.fromEntries(new URL(request.url).searchParams);
async function attachmentForm(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (!/^multipart\/form-data\s*;/i.test(contentType))
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "请使用 multipart/form-data",
    );
  const limit = maxAttachmentBytes + 64 * 1024;
  const length = request.headers.get("content-length");
  if (length && Number(length) > limit)
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "上传请求过大");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_MULTIPART", "上传正文不能为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(413, "PAYLOAD_TOO_LARGE", "上传请求过大");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch {
    throw new ApiError(400, "INVALID_MULTIPART", "上传表单格式无效");
  }
  if (
    [...form.keys()].some((key) => !["file", "version"].includes(key)) ||
    form.getAll("file").length !== 1 ||
    form.getAll("version").length !== 1
  )
    throw new ApiError(
      400,
      "INVALID_MULTIPART",
      "仅允许一个 file 与一个 version 字段",
    );
  const file = form.get("file");
  const version = form.get("version");
  if (
    !(file instanceof File) ||
    typeof version !== "string" ||
    !/^[1-9]\d*$/.test(version)
  )
    throw new ApiError(400, "INVALID_MULTIPART", "请提供文件和有效版本");
  return {
    file,
    version: draftVersionSchema.parse({ version: Number(version) }).version,
  };
}
export function uploadAttachmentHandler(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    emptyAttachmentQuery.parse(query(request));
    const id = z.uuid().parse((await context.params).id);
    const token = requestToken(request);
    await authorizeAttachmentUpload(token, id);
    const { file, version } = await attachmentForm(request);
    return data(
      await uploadTravelAttachment(
        token,
        id,
        version,
        Buffer.from(await file.arrayBuffer()),
        file.name,
        file.type,
      ),
      201,
    );
  });
}
export function attachmentsHandler(request: Request, context: Context) {
  return endpoint(async () => {
    emptyAttachmentQuery.parse(query(request));
    return data(
      await listTravelAttachments(
        requestToken(request),
        z.uuid().parse((await context.params).id),
      ),
    );
  });
}
export function deleteAttachmentHandler(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    emptyAttachmentQuery.parse(query(request));
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const attachmentId = z.uuid().parse(params.attachmentId);
    const { version } = await jsonBody(request, draftVersionSchema);
    return data(
      await deleteTravelAttachment(
        requestToken(request),
        id,
        attachmentId,
        version,
      ),
    );
  });
}
export function attachmentContentHandler(request: Request, context: Context) {
  return endpoint(async () => {
    const { disposition } = attachmentContentQuery.parse(query(request));
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const attachmentId = z.uuid().parse(params.attachmentId);
    const { attachment, bytes } = await getTravelAttachmentContent(
      requestToken(request),
      id,
      attachmentId,
    );
    const encoded = encodeURIComponent(attachment.originalName).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Length": String(bytes.length),
        "Content-Disposition": `${disposition}; filename="attachment"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "sandbox; default-src 'none'; frame-ancestors 'self'",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
}
