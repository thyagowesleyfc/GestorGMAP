import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, expect, it } from "vitest";

import { PrismaEntitiesGmapExportReader } from "../../src/modules/entities/infrastructure/prisma-entities-gmap-export-reader";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl
    },
    timeout: 90000
  });
}

describe("PrismaEntitiesGmapExportReader", () => {
  it("reads public GRE, municipality and entity rows for the entidades_gmap auxiliary export", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl
        }
      }
    });

    try {
      await runPrismaMigrateDeploy(databaseUrl);
      await prisma.$connect();

      const firstGre = await prisma.gre.create({
        data: {
          code: "GRE-01",
          name: "1a Gerencia Regional de Educacao"
        }
      });
      const secondGre = await prisma.gre.create({
        data: {
          code: "GRE-02",
          name: "2a Gerencia Regional de Educacao",
          active: false
        }
      });
      const teresina = await prisma.municipality.create({
        data: {
          ibgeCode: "2211001",
          name: "Teresina",
          greId: firstGre.id
        }
      });
      await prisma.municipality.create({
        data: {
          ibgeCode: "2207702",
          name: "Parnaiba",
          greId: secondGre.id,
          active: false
        }
      });
      const school = await prisma.entity.create({
        data: {
          code: "ENT-ESC-001",
          name: "Unidade Escolar Teste",
          entityType: "ESCOLA",
          greId: firstGre.id,
          municipalityId: teresina.id
        }
      });
      await prisma.entity.create({
        data: {
          code: "ENT-ANX-001",
          name: "Anexo Escolar Teste",
          entityType: "ANEXO",
          greId: firstGre.id,
          municipalityId: teresina.id,
          parentEntityId: school.id
        }
      });
      await prisma.entity.create({
        data: {
          code: "ENT-SEC-001",
          name: "Secretaria Administrativa",
          entityType: "SECRETARIA",
          greId: firstGre.id,
          active: false
        }
      });

      const reader = new PrismaEntitiesGmapExportReader(prisma);
      const exportData = await reader.read();

      expect(JSON.stringify(exportData)).not.toMatch(/"id"/);
      expect(exportData).toEqual({
        gres: [
          {
            codigo_gre: "GRE-01",
            nome_gre: "1a Gerencia Regional de Educacao",
            ativo: true
          },
          {
            codigo_gre: "GRE-02",
            nome_gre: "2a Gerencia Regional de Educacao",
            ativo: false
          }
        ],
        municipios: [
          {
            codigo_ibge_municipio: "2207702",
            nome_municipio: "Parnaiba",
            codigo_gre: "GRE-02",
            nome_gre: "2a Gerencia Regional de Educacao",
            ativo: false
          },
          {
            codigo_ibge_municipio: "2211001",
            nome_municipio: "Teresina",
            codigo_gre: "GRE-01",
            nome_gre: "1a Gerencia Regional de Educacao",
            ativo: true
          }
        ],
        entidades: [
          {
            codigo_entidade: "ENT-ANX-001",
            nome_entidade: "Anexo Escolar Teste",
            tipo_entidade: "ANEXO",
            codigo_gre: "GRE-01",
            nome_gre: "1a Gerencia Regional de Educacao",
            codigo_ibge_municipio: "2211001",
            nome_municipio: "Teresina",
            codigo_entidade_pai: "ENT-ESC-001",
            nome_entidade_pai: "Unidade Escolar Teste",
            ativo: true
          },
          {
            codigo_entidade: "ENT-ESC-001",
            nome_entidade: "Unidade Escolar Teste",
            tipo_entidade: "ESCOLA",
            codigo_gre: "GRE-01",
            nome_gre: "1a Gerencia Regional de Educacao",
            codigo_ibge_municipio: "2211001",
            nome_municipio: "Teresina",
            codigo_entidade_pai: null,
            nome_entidade_pai: null,
            ativo: true
          },
          {
            codigo_entidade: "ENT-SEC-001",
            nome_entidade: "Secretaria Administrativa",
            tipo_entidade: "SECRETARIA",
            codigo_gre: "GRE-01",
            nome_gre: "1a Gerencia Regional de Educacao",
            codigo_ibge_municipio: null,
            nome_municipio: null,
            codigo_entidade_pai: null,
            nome_entidade_pai: null,
            ativo: false
          }
        ]
      });
    } finally {
      await prisma.$disconnect().catch(() => undefined);
      await postgres.stop();
    }
  });
});
