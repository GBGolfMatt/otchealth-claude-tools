/**
 * Cross-lane policy for the permanently segregated personal legal memory ring.
 *
 * The check is pure so callers can enforce it before opening either lane's store.
 */
const SEGREGATED = new Set(["clo-personal"]);

export function assertCrossLaneAllowed(writer, target) {
  const actor = String(writer || "").trim().toLowerCase();
  const destination = String(target || "").trim().toLowerCase();
  if (destination && !actor) {
    throw new Error("writer identity is required before target lane access");
  }
  if (actor !== destination && (SEGREGATED.has(actor) || SEGREGATED.has(destination))) {
    throw new Error("cross-lane access involving clo-personal is prohibited");
  }
}
