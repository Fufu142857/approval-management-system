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
  authorizePurchaseAttachmentUpload,
  uploadPurchaseAttachment,
  listPurchaseAttachments,
  listSubmittedPurchaseAttachments,
  getSubmittedPurchaseAttachmentContent,
  deletePurchaseAttachment,
  getPurchaseAttachmentContent,
} from "./purchase-attachments";

type Context = {
  params: Promise<{ id: string; quoteId?: string; attachmentId?: string }>;
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
export function uploadPurchaseAttachmentHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    checkOrigin(request);
    emptyAttachmentQuery.parse(query(request));
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const quoteId = z.uuid().parse(params.quoteId);
    const token = requestToken(request);
    await authorizePurchaseAttachmentUpload(token, id, quoteId);
    const { file, version } = await attachmentForm(request);
    return data(
      await uploadPurchaseAttachment(
        token,
        id,
        quoteId,
        version,
        Buffer.from(await file.arrayBuffer()),
        file.name,
        file.type,
      ),
      201,
    );
  });
}
export function purchaseAttachmentsHandler(request: Request, context: Context) {
  return endpoint(async () => {
    emptyAttachmentQuery.parse(query(request));
    return data(
      await listPurchaseAttachments(
        requestToken(request),
        z.uuid().parse((await context.params).id),
      ),
    );
  });
}
export function deletePurchaseAttachmentHandler(
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
      await deletePurchaseAttachment(
        requestToken(request),
        id,
        attachmentId,
        version,
      ),
    );
  });
}
export function purchaseAttachmentContentHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    const { disposition } = attachmentContentQuery.parse(query(request));
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const attachmentId = z.uuid().parse(params.attachmentId);
    const { attachment, bytes } = await getPurchaseAttachmentContent(
      requestToken(request),
      id,
      attachmentId,
    );
    return attachmentResponse(attachment, bytes, disposition);
  });
}

export function submittedPurchaseAttachmentsHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    emptyAttachmentQuery.parse(query(request));
    return data(
      await listSubmittedPurchaseAttachments(
        requestToken(request),
        z.uuid().parse((await context.params).id),
      ),
    );
  });
}

export function submittedPurchaseAttachmentContentHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    const { disposition } = attachmentContentQuery.parse(query(request));
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const attachmentId = z.uuid().parse(params.attachmentId);
    const { attachment, bytes } = await getSubmittedPurchaseAttachmentContent(
      requestToken(request),
      id,
      attachmentId,
    );
    return attachmentResponse(attachment, bytes, disposition);
  });
}
