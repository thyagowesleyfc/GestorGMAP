import type { PrismaClient, UserSession } from "@prisma/client";

import { generateSessionToken, hashSessionToken } from "./session-token";

type PrismaSessionClient = Pick<PrismaClient, "userSession">;

export type SessionRecord = Omit<UserSession, "sessionTokenHash">;

export type CreateSessionInput = {
  userId: string;
  expiresAt: Date;
  userAgent?: string;
  ipAddress?: string;
  now?: Date;
};

export type CreatedSession = {
  token: string;
  session: SessionRecord;
};

function toSessionRecord(session: UserSession): SessionRecord {
  return {
    id: session.id,
    userId: session.userId,
    userAgent: session.userAgent,
    ipAddress: session.ipAddress,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    lastSeenAt: session.lastSeenAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

export class PrismaSessionStore {
  constructor(private readonly prisma: PrismaSessionClient) {}

  async create(input: CreateSessionInput): Promise<CreatedSession> {
    const token = generateSessionToken();
    const session = await this.prisma.userSession.create({
      data: {
        userId: input.userId,
        sessionTokenHash: hashSessionToken(token),
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
        expiresAt: input.expiresAt,
        lastSeenAt: input.now ?? new Date()
      }
    });

    return {
      token,
      session: toSessionRecord(session)
    };
  }

  async findActiveByToken(token: string, now = new Date()): Promise<SessionRecord | null> {
    const session = await this.prisma.userSession.findFirst({
      where: {
        sessionTokenHash: hashSessionToken(token),
        revokedAt: null,
        expiresAt: {
          gt: now
        }
      }
    });

    return session === null ? null : toSessionRecord(session);
  }

  async listActiveForUser(userId: string, now = new Date()): Promise<SessionRecord[]> {
    const sessions = await this.prisma.userSession.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: {
          gt: now
        }
      },
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }]
    });

    return sessions.map(toSessionRecord);
  }

  async revokeByToken(token: string, revokedAt = new Date()): Promise<number> {
    const result = await this.prisma.userSession.updateMany({
      where: {
        sessionTokenHash: hashSessionToken(token),
        revokedAt: null
      },
      data: {
        revokedAt,
        lastSeenAt: revokedAt
      }
    });

    return result.count;
  }

  async revokeById(sessionId: string, revokedAt = new Date()): Promise<number> {
    const result = await this.prisma.userSession.updateMany({
      where: {
        id: sessionId,
        revokedAt: null
      },
      data: {
        revokedAt,
        lastSeenAt: revokedAt
      }
    });

    return result.count;
  }
}
