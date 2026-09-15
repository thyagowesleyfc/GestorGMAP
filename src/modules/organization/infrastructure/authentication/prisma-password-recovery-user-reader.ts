import type { PrismaClient } from "@prisma/client";

import type {
  PasswordRecoveryUser,
  PasswordRecoveryUserReader
} from "../../application/request-password-recovery";
import { normalizeLoginIdentifier } from "../../domain/login-identifier";

type PrismaPasswordRecoveryUserClient = Pick<PrismaClient, "userAccount">;

export class PrismaPasswordRecoveryUserReader implements PasswordRecoveryUserReader {
  constructor(private readonly prisma: PrismaPasswordRecoveryUserClient) {}

  async findByLoginIdentifier(loginIdentifier: string): Promise<PasswordRecoveryUser | null> {
    const user = await this.prisma.userAccount.findUnique({
      where: {
        loginIdentifier: normalizeLoginIdentifier(loginIdentifier)
      },
      select: {
        id: true,
        status: true
      }
    });

    return user;
  }
}
