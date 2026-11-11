import { normalizeDomain } from '@holdfast/shared';
import { verifyBrand, type Db } from '@holdfast/core';

/**
 * `npm run admin:verify <domain>` (HF-011a): verify the PENDING brand that owns `<domain>`
 * through the same core `verifyBrand` as `POST /api/admin/brands/:id/verify`. Run by an operator
 * locally or from the Render Shell; audited as `SYSTEM` with `data.admin = true, via = 'cli'`.
 */
export interface AdminVerifyOutcome {
  exitCode: 0 | 1 | 2;
  message: string;
}

export const ADMIN_VERIFY_USAGE = 'Usage: npm run admin:verify <domain>   e.g. aurelaudio.example';

export async function adminVerify(db: Db, args: readonly string[]): Promise<AdminVerifyOutcome> {
  if (args.length !== 1) return { exitCode: 2, message: ADMIN_VERIFY_USAGE };
  const domain = normalizeDomain(args[0]!);
  if (!domain) {
    return { exitCode: 2, message: `"${args[0]}" is not a domain.\n${ADMIN_VERIFY_USAGE}` };
  }

  const result = await verifyBrand(db, { domain }, { type: 'SYSTEM', via: 'cli' });
  if (!result.ok) {
    return result.error.code === 'NOT_FOUND'
      ? { exitCode: 1, message: `No brand has the domain ${domain}.` }
      : { exitCode: 1, message: `Brand ${domain} was REJECTED; not verifying it.` };
  }
  const { brand, changed } = result;
  const at = brand.verifiedAt ? new Date(brand.verifiedAt).toISOString() : 'unknown';
  return {
    exitCode: 0,
    message: changed
      ? `Verified ${brand.name} (${domain}, ${brand.id}) at ${at}.`
      : `${brand.name} (${domain}, ${brand.id}) was already verified at ${at}; nothing changed.`,
  };
}
