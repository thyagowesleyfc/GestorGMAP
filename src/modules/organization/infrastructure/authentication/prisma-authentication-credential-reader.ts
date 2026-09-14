import type { PrismaClient } from "@prisma/client";

import type {
  AuthenticationCredential,
  AuthenticationCredentialReader
} from "../../application/authenticate-user";
import { normalizeLoginIdentifier } from "../../domain/login-identifier";

type PrismaAuthenticationCredentialClient = Pick<PrismaClient, "userAccount">;

export class PrismaAuthenticationCredentialReader implements AuthenticationCredentialReader {
  constructor(private readonly prisma: PrismaAuthenticationCredentialClient) {}

  async findByLoginIdentifier(loginIdentifier: string): Promise<AuthenticationCredential | null> {
    const user = await this.prisma.userAccount.findUnique({
      where: {
        loginIdentifier: normalizeLoginIdentifier(loginIdentifier)
      },
      select: {
        id: true,
        status: true,
        passwordCredential: {
          select: {
            passwordHash: true
          }
        }
      }
    });

    if (user === null || user.passwordCredential === null) {
      return null;
    }

    return {
      user: {
        id: user.id,
        status: user.status
      },
      passwordHash: user.passwordCredential.passwordHash
    };
  }
}
