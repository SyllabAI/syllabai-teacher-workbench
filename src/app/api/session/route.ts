import { NextResponse } from "next/server";
import { issueSessionForReviewer, SESSION_COOKIE, sessionFromRequest, cookieConfig } from "@/lib/session";
import { verifyReviewerToken } from "@/lib/reviewers";

/**
 * R3-6/R3-7 session gate.
 *
 * R3-7 CHANGE: a session is issued ONLY against a provisioned reviewer
 * token. The display name comes from the reviewer registry — client-supplied
 * displayName fields are IGNORED (they can no longer mint or impersonate an
 * identity). The session's only privilege remains staging intent; canonical
 * apply is importer-only. Revocation/re-provisioning kills outstanding
 * sessions on their next staging write (registry revalidation).
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const verify = verifyReviewerToken(typeof body.token === "string" ? body.token : "");
  if (!verify.ok) {
    return NextResponse.json({ error: verify.error }, { status: verify.status });
  }
  const { token, payload } = issueSessionForReviewer(verify.reviewer);
  const res = NextResponse.json({
    ok: true,
    role: payload.role,
    name: payload.name,
    reviewerId: payload.reviewerId,
    expiresAt: new Date(payload.exp).toISOString(),
  });
  res.cookies.set(SESSION_COOKIE, token, cookieConfig(12 * 60 * 60));
  return res;
}

export async function DELETE(req: Request) {
  const existing = sessionFromRequest(req);
  const res = NextResponse.json({ ok: true, closed: !!existing });
  res.cookies.set(SESSION_COOKIE, "", cookieConfig(0));
  return res;
}
