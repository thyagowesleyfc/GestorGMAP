import type { PrismaClient } from "@prisma/client";

import type { PasswordRecoveryResetStore } from "../../application/reset-password-with-recovery-token";

type PrismaPasswordRecoveryResetClient = Pick<
  PrismaClient,
  "$transaction" | "passwordRecoveryRequest" | "passwordCredential" | "userSession"
>;

export class PrismaPasswordRecoveryResetStore implements PasswordRecoveryResetStore {
  constructor(private readonly prisma: PrismaPasswordRecoveryResetClient) {}

  async resetPassword(input: {
    recoveryTokenHash: string;
    passwordHash: string;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();

    return this.prisma.$transaction(async (transaction) => {
      const recoveryRequest = await transaction.passwordRecoveryRequest.findFirst({
        where: {
          recoveryTokenHash: input.recoveryTokenHash,
          usedAt: null,
          expiresAt: {
            gt: now
          },
          user: {
            status: "ACTIVE"
          }
        },
        select: {
          id: true,
          userId: true
        }
      });

      if (recoveryRequest === null) {
        return false;
      }

      const consumed = await transaction.passwordRecoveryRequest.updateMany({
        where: {
          id: recoveryRequest.id,
          usedAt: null,
          expiresAt: {
            gt: now
          }
        },
        data: {
          usedAt: now,
          updatedAt: now
        }
      });

      if (consumed.count !== 1) {
        return false;
      }

      await transaction.passwordCredential.upsert({
        where: {
          userId: recoveryRequest.userId
        },
        create: {
          userId: recoveryRequest.userId,
          passwordHash: input.passwordHash,
          passwordUpdatedAt: now,
          updatedAt: now
        },
        update: {
          passwordHash: input.passwordHash,
          passwordUpdatedAt: now,
          updatedAt: now
        }
      });

      await transaction.userSession.updateMany({
        where: {
          userId: recoveryRequest.userId,
          revokedAt: null,
          expiresAt: {
            gt: now
          }
        },
        data: {
          revokedAt: now,
          lastSeenAt: now
        }
      });

      return true;
    });
  }
}
