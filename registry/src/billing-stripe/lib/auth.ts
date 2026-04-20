/**
 * Minimal auth middleware for billing routes.
 *
 * Relies on `req.session.user.id` being set by your Parcae auth adapter
 * (either @parcae/auth-betterauth or @parcae/auth-clerk). We keep this
 * local to the billing package so consumers don't have to wire a cross-
 * cutting `@/utilities/auth` import.
 */
import { unauthorized } from "@parcae/backend";

/**
 * Polka/Express middleware. Sets `req.userId` when authenticated,
 * responds 401 otherwise.
 */
export function requireBillingAuth(req: any, res: any, next: () => void): void {
  const userId = req.session?.user?.id;
  if (!userId) {
    unauthorized(res);
    return;
  }
  req.userId = userId;
  next();
}
