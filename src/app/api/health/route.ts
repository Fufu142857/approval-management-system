export const dynamic = "force-dynamic";

// Liveness only. Database readiness will be a separate concern in S2.
export function GET() {
  return Response.json(
    {
      data: {
        service: "approval-management-system",
        status: "ok",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
