import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions';

export const PERMISSIONS_KEY = 'admin:permissions';

/**
 * What a sub-admin needs to reach this route. An OWNER skips the check.
 *
 * Listing more than one means all of them are required — routes that read and
 * then act, like claiming a fee, ask for both halves rather than trusting that
 * whoever granted the second also granted the first.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
