import { NextResponse } from "next/server";
import { buildExportBundle, writeDurableExport } from "@/lib/decision-log";
import { getReviewIndex } from "@/lib/review-data";
import { isReadOnlyDeployment } from "@/lib/prod-config";

export async function GET() {
  try {
    const idx = getReviewIndex();
    const bundle = buildExportBundle({
      label: idx.label,
      dumpSha256: idx.dumpSha256,
      identity: idx.identity,
    });
    if (isReadOnlyDeployment()) {
      // Readonly mirror: the filesystem is not writable on serverless hosts —
      // return the SAME bundle bytes without the durable local copy.
      return new NextResponse(JSON.stringify(bundle, null, 1), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="decision-bundle.json"`,
          "X-Durable-Copy": "skipped (readonly deployment)",
        },
      });
    }
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
