import { z } from "zod";
import { ApiError } from "./errors";
import {
  attachmentContentQuery,
  emptyAttachmentQuery,
} from "../lib/attachments";
import { draftVersionSchema } from "../lib/travel";
import { attachmentForm, attachmentResponse } from "./attachment-http";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";
import {
  authorizeReimbursementAttachmentUpload,
  uploadReimbursementAttachment,
  listReimbursementAttachments,
  listSubmittedReimbursementAttachments,
  getSubmittedReimbursementAttachmentContent,
  deleteReimbursementAttachment,
  getReimbursementAttachmentContent,
} from "./reimbursement-attachments";

type Context = {
  params: Promise<{ id: string; itemId?: string; attachmentId?: string }>;
};
function query(request: Request) {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(request.url).searchParams) {
    if (Object.hasOwn(result, key))
      throw new ApiError(400, "VALIDATION_ERROR", "查询参数不能重复");
    result[key] = value;
  }
  return result;
}
export function uploadReimbursementAttachmentHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    checkOrigin(request);
    emptyAttachmentQuery.parse(query(request));
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const itemId = z.uuid().parse(params.itemId);
    const token = requestToken(request);
    await authorizeReimbursementAttachmentUpload(token, id, itemId);
    const { file, version, receiptNumber } = await attachmentForm(
      request,
      true,
    );
    return data(
      await uploadReimbursementAttachment(
        token,
        id,
        itemId,
        version,
        Buffer.from(await file.arrayBuffer()),
        file.name,
        file.type,
        receiptNumber,
      ),
      201,
    );
  });
}
export function reimbursementAttachmentsHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    emptyAttachmentQuery.parse(query(request));
    return data(
      await listReimbursementAttachments(
        requestToken(request),
        z.uuid().parse((await context.params).id),
      ),
    );
  });
}
export function deleteReimbursementAttachmentHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    checkOrigin(request);
    emptyAttachmentQuery.parse(query(request));
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const attachmentId = z.uuid().parse(params.attachmentId);
    const { version } = await jsonBody(request, draftVersionSchema);
    return data(
      await deleteReimbursementAttachment(
        requestToken(request),
        id,
        attachmentId,
        version,
      ),
    );
  });
}
export function reimbursementAttachmentContentHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    const { disposition } = attachmentContentQuery.parse(query(request));
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const attachmentId = z.uuid().parse(params.attachmentId);
    const { attachment, bytes } = await getReimbursementAttachmentContent(
      requestToken(request),
      id,
      attachmentId,
    );
    return attachmentResponse(attachment, bytes, disposition);
  });
}

export function submittedReimbursementAttachmentsHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    emptyAttachmentQuery.parse(query(request));
    return data(
      await listSubmittedReimbursementAttachments(
        requestToken(request),
        z.uuid().parse((await context.params).id),
      ),
    );
  });
}

export function submittedReimbursementAttachmentContentHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    const { disposition } = attachmentContentQuery.parse(query(request));
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const attachmentId = z.uuid().parse(params.attachmentId);
    const { attachment, bytes } =
      await getSubmittedReimbursementAttachmentContent(
        requestToken(request),
        id,
        attachmentId,
      );
    return attachmentResponse(attachment, bytes, disposition);
  });
}
