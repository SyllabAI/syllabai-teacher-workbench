import { NextResponse } from "next/server";
import { getReviewIndex } from "@/lib/review-data";

export async function GET() {
  try {
    return NextResponse.json(getReviewIndex());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
