/**
 * Resolve the app's public base URL for links and email-embedded assets.
 *
 * Order: explicit APP_URL override → REPLIT_DOMAINS (holds the published
 * domain(s) in production deployments and the dev domain in the workspace)
 * → REPLIT_DEV_DOMAIN (workspace only).
 */
export function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return "";
}
