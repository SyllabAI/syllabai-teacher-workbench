import { NextResponse } from "next/server";
import { getAppliedEvents } from "@/lib/canonical";

/**
 * R3-6 applied-events feed: everything committed to canonical
 * teacher_validation_events (V18) by the gated importer, with full
 * attribution. READ-ONLY (connection-level default_transaction_read_only).
 * Fail-closed: DB unavailable -> available:false (UI degrades to
 * "treat staged as NOT APPLIED").
 */
export async function GET() {
  const res = await getAppliedEvents(2000);
  if (!res.available) {
    return NextResponse.json(
      { available: false, events: [], error: res.error },
      { status: 200 } // degradation is a valid, expected state — not a server error
    );
  }
  return NextResponse.json({
    available: true,
    checkedAt: new Date().toISOString(),
    events: res.events,
  });
}
