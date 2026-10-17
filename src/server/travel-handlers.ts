import { z } from "zod";
import {
  draftVersionSchema,
  replaceTravelDraftSchema,
  travelDraftListSchema,
  travelDraftSchema,
} from "../lib/travel";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";
import {
  createTravelDraft,
  deleteTravelDraft,
  getTravelDraft,
  listTravelDrafts,
  replaceTravelDraft,
} from "./travel";

type DraftContext = { params: Promise<{ id: string }> };
export function createTravelDraftHandler(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const input = await jsonBody(request, travelDraftSchema);
    return data(await createTravelDraft(requestToken(request), input), 201);
  });
}
export function listTravelDraftsHandler(request: Request) {
  return endpoint(async () =>
    data(
      await listTravelDrafts(
        requestToken(request),
        travelDraftListSchema.parse(
          Object.fromEntries(new URL(request.url).searchParams),
        ),
      ),
    ),
  );
}
export function getTravelDraftHandler(request: Request, context: DraftContext) {
  return endpoint(async () =>
    data(
      await getTravelDraft(
        requestToken(request),
        z.uuid().parse((await context.params).id),
      ),
    ),
  );
}
export function replaceTravelDraftHandler(
  request: Request,
  context: DraftContext,
) {
  return endpoint(async () => {
    checkOrigin(request);
    const id = z.uuid().parse((await context.params).id);
    const input = await jsonBody(request, replaceTravelDraftSchema);
    return data(await replaceTravelDraft(requestToken(request), id, input));
  });
}
export function deleteTravelDraftHandler(
  request: Request,
  context: DraftContext,
) {
  return endpoint(async () => {
    checkOrigin(request);
    const id = z.uuid().parse((await context.params).id);
    const input = await jsonBody(request, draftVersionSchema);
    return data(
      await deleteTravelDraft(requestToken(request), id, input.version),
    );
  });
}
