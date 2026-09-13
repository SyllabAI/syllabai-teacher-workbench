import { NextResponse } from "next/server";
import { getDossier } from "@/lib/review-data";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const dossier = getDossier(id);
  if (!dossier) {
    return NextResponse.json({ error: "dossier not found" }, { status: 404 });
  }
  return NextResponse.json(dossier);
}
