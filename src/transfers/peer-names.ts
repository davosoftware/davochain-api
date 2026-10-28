import type { PrismaService } from '../prisma/prisma.service';
import { displayName } from './pay-username';

export interface PeerName {
  /** Their payment username, or null if they have none. */
  username: string | null;
  /** "Ada O." */
  displayName: string;
}

/**
 * Who the other side of each send between DavoChain customers is, for the
 * histories (28 Oct 2026). One query for the whole page, not one per row.
 */
export async function peerNames(prisma: Pick<PrismaService, 'user'>, ids: Array<string | null | undefined>): Promise<Map<string, PeerName>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: wanted } },
    select: { id: true, firstName: true, lastName: true, payUsername: true },
  });
  return new Map(users.map((u) => [u.id, { username: u.payUsername, displayName: displayName(u) }]));
}
