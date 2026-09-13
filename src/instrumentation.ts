/**
 * R3-7 — production fail-closed startup gate.
 *
 * Next.js calls register() once per server process start. In production
 * (NODE_ENV=production, i.e. `next start`), ANY configuration problem throws
 * here: the process fails to start visibly instead of degrading into an
 * insecure serving path (auto-generated secrets, Secure cookies over plain
 * HTTP, silent DB defaults, missing reviewer registry).
 *
 * Development (`next dev`) is intentionally unaffected.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertProductionConfig } = await import("./lib/prod-config");
  const result = assertProductionConfig();
  if (!result.ok) {
    throw new Error(
      "R3-7 production configuration check FAILED — refusing to start:\n- " +
        result.problems.join("\n- ")
    );
  }
}
