import { NextResponse } from "next/server";
import { buildExportBundle, writeDurableExport } from "@/lib/decision-log";
import { getReviewIndex } from "@/lib/review-data";

export async function GET() {
  try {
    const idx = getReviewIndex();
    const bundle = buildExportBundle({
      label: idx.label,
      dumpSha256: idx.dumpSha256,
      identity: idx.identity,
    });
    const file = writeDurableExport(bundle);
    return new NextResponse(JSON.stringify(bundle, null, 1), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${file.split("/").pop()}"`,
        "X-Durable-Copy": file,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
