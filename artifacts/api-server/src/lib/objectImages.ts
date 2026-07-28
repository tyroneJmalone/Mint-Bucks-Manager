import { ObjectStorageService } from "./objectStorage";

/**
 * Normalize a freshly-uploaded image path and mark it publicly readable so
 * email clients can load it without auth. Returns the normalized /objects path.
 * Throws if the path is not a canonical object-entity path.
 */
export async function normalizeEmailImage(rawPath: string): Promise<string> {
  const svc = new ObjectStorageService();
  const normalized = await svc.trySetObjectEntityAclPolicy(rawPath, {
    owner: "system",
    visibility: "public",
  });
  // Only accept canonical object-entity paths; anything else is not a valid
  // upload reference and must be rejected (it would also break email <img> src).
  if (!/^\/objects\/[A-Za-z0-9._/-]+$/.test(normalized)) {
    throw new Error(`Invalid object path: ${normalized}`);
  }
  return normalized;
}
