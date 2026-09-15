import type { PrismaClient } from "@prisma/client";

import type { PasswordRecoveryRequestStore } from "../../application/request-password-recovery";

type PrismaPasswordRecoveryRequestClient = Pick<PrismaClient, "passwordRecoveryRequest">;

export class PrismaPasswordRecoveryRequestStore implements PasswordRecoveryRequestStore {
  constructor(private readonly prisma: PrismaPasswordRecoveryRequestClient) {}

  async create(input: {
    userId: string;
    recoveryTokenHash: string;
    expiresAt: Date;
    now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();

    await this.prisma.passwordRecoveryRequest.create({
      data: {
        userId: input.userId,
        recoveryTokenHash: input.recoveryTokenHash,
        expiresAt: input.expiresAt,
        createdAt: now,
        updatedAt: now
      }
    });
  }
}
