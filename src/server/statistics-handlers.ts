import { statisticsSchema } from "../lib/statistics";
import { getFixedBusinessStatistics } from "./statistics";
import { ApiError } from "./errors";
import { data, endpoint, requestToken } from "./http";

export function statisticsHandler(request: Request) {
  return endpoint(async () => {
    const query: Record<string, string> = Object.create(null);
    for (const [key, value] of new URL(request.url).searchParams) {
      if (Object.hasOwn(query, key))
        throw new ApiError(400, "VALIDATION_ERROR", "查询参数不能重复");
      query[key] = value;
    }
    return data(
      await getFixedBusinessStatistics(
        requestToken(request),
        statisticsSchema.parse(query),
      ),
    );
  });
}
