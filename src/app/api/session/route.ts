import { NextResponse } from "next/server";
import { issueSession, SESSION_COOKIE, sessionFromRequest } from "@/lib/session";

/**
 * R3-6 session gate: POST opens a teacher staging session (HttpOnly HMAC
 * cookie); DELETE closes it. This grants ONLY the ability to stage intent —
 * canonical validation state is never writable from the serving path.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const result = issueSession(String(body.displayName || ""));
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }
  const res = NextResponse.json({
    ok: true,
    role: result.payload.role,
    name: result.payload.name,
    expiresAt: new Date(result.payload.exp).toISOString(),
  });
  res.cookies.set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
  return res;
}

export async function DELETE(req: Request) {
  const existing = sessionFromRequest(req);
  const res = NextResponse.json({ ok: true, closed: !!existing });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  return res;
}
