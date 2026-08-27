/**
 * Wire-visible error messages that mark a socket session boundary.
 *
 * The backend refuses resyncs and RPCs with these exact strings, and the
 * SDK fails CLOSED when it sees one (rendered rows from the prior
 * authorization are blanked instead of retained). Matching is by
 * substring on the client, so a reworded refusal silently downgrades
 * fail-closed to stale-while-revalidate: change these values nowhere
 * else, and never rephrase a refusal without going through this table.
 */
export const SESSION_BOUNDARY_ERRORS = {
  changed: "Session changed",
  notReconciled: "Session is not reconciled",
  terminated: "Session terminated",
} as const;

/** True when an error message marks a session/authorization boundary. */
export function isSessionBoundaryError(message: string): boolean {
  return (
    message.includes(SESSION_BOUNDARY_ERRORS.changed) ||
    message.includes(SESSION_BOUNDARY_ERRORS.notReconciled) ||
    message.includes(SESSION_BOUNDARY_ERRORS.terminated)
  );
}
