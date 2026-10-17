import { z } from "zod";
import { draftVersionSchema } from "../lib/travel";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";
import { getTravelApplication, submitTravelDraft } from "./travel-submission";

type Context = { params: Promise<{ id: string }> };
export function submitTravelHandler(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    const id = z.uuid().parse((await context.params).id);
    const { version } = await jsonBody(request, draftVersionSchema);
    return data(await submitTravelDraft(requestToken(request), id, version));
  });
}
export function travelApplicationHandler(request: Request, context: Context) {
  return endpoint(async () =>
    data(
      await getTravelApplication(
        requestToken(request),
        z.uuid().parse((await context.params).id),
      ),
    ),
  );
}
