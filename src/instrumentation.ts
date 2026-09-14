/**
 * R3-7 — production fail-closed startup gate.
 *
 * Next.js calls register() once per server process start. In production
 * (NODE_ENV=production, i.e. `next start`), ANY configuration problem must
 * kill the process visibly instead of degrading into an insecure serving
 * path (auto-generated secrets, Secure cookies over plain HTTP, silent DB
 * defaults, missing reviewer registry).
 *
 * R3-8 REAL-HOST FINDING (must not regress): under Next.js 16.1.3 standalone
 * (verified on the actual deployment host, node AND bun runtimes), a throw
 * from register() is captured by the framework as an "unhandledRejection" —
 * the process stays ALIVE and listening, answering 500 on every route.
 * That is degradation, not fail-closed. The gate therefore calls
 * process.exit(1) explicitly: exit cannot be swallowed by framework error
 * handlers, and the listening socket never opens. A thrown error is kept as
 * well for runtimes/modes where the process exit path differs.
 *
 * Development (`next dev`) is intentionally unaffected.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertProductionConfig } = await import("./lib/prod-config");
  const result = assertProductionConfig();
  if (!result.ok) {
    const message =
      "R3-7 production configuration check FAILED — refusing to start:\n- " +
      result.problems.join("\n- ");
    console.error("FATAL: " + message);
    // Belt and braces: exit is uncatchable; the throw documents intent for
    // runtimes where instrumentation failures are fatal by default.
    if (process.env.NODE_ENV === "production") process.exit(1);
    throw new Error(message);
  }
}
