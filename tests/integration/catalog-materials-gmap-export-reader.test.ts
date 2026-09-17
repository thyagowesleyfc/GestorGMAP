import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, expect, it } from "vitest";

import { PrismaMaterialsGmapExportReader } from "../../src/modules/catalog/infrastructure/prisma-materials-gmap-export-reader";

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

describe("PrismaMaterialsGmapExportReader", () => {
  it("reads public material catalog rows for the materiais_gmap auxiliary export", async () => {
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

      const classRecord = await prisma.materialClass.create({
        data: {
          code: "INFORMATICA",
          name: "Informatica"
        }
      });
      const secondaryClassRecord = await prisma.materialClass.create({
        data: {
          code: "MOBILIARIO",
          name: "Mobiliario",
          active: false
        }
      });
      const monitor = await prisma.materialSingular.create({
        data: {
          code: "MAT-MONITOR",
          name: "Monitor",
          classId: classRecord.id,
          controlType: "INDIVIDUAL",
          isTombable: true,
          patrimonialGroupCode: "EQUIPAMENTO",
          allowsCorrectiveMaintenance: true,
          allowsPreventiveMaintenance: true,
          allowsReconditioning: true,
          allowsReplacement: true
        }
      });
      const keyboard = await prisma.materialSingular.create({
        data: {
          code: "MAT-TECLADO",
          name: "Teclado",
          classId: classRecord.id,
          controlType: "INDIVIDUAL",
          isTombable: true,
          patrimonialGroupCode: "EQUIPAMENTO"
        }
      });
      await prisma.materialSingular.create({
        data: {
          code: "MAT-CADEIRA",
          name: "Cadeira",
          classId: secondaryClassRecord.id,
          controlType: "INDIVIDUAL",
          isTombable: true,
          patrimonialGroupCode: "MOBILIARIO",
          active: false
        }
      });
      const configuration = await prisma.materialConfiguration.create({
        data: {
          code: "CFG-MICROCOMPUTADOR-TIPO-VI",
          name: "Microcomputador Tipo VI",
          configurationType: "COMPOSTO",
          components: {
            createMany: {
              data: [
                {
                  materialSingularId: monitor.id,
                  quantity: 1
                },
                {
                  materialSingularId: keyboard.id,
                  quantity: 1
                }
              ]
            }
          }
        }
      });
      await prisma.materialConfiguration.create({
        data: {
          code: "CFG-KIT-LABORATORIO",
          name: "Kit Laboratorio",
          configurationType: "KIT",
          active: false
        }
      });

      const reader = new PrismaMaterialsGmapExportReader(prisma);
      const exportData = await reader.read();

      expect(JSON.stringify(exportData)).not.toMatch(/"id"/);
      expect(exportData).toEqual({
        classes: [
          {
            codigo_classe: "INFORMATICA",
            nome_classe: "Informatica",
            ativo: true
          },
          {
            codigo_classe: "MOBILIARIO",
            nome_classe: "Mobiliario",
            ativo: false
          }
        ],
        materiaisSingulares: [
          {
            codigo_material: "MAT-CADEIRA",
            nome_material: "Cadeira",
            codigo_classe: "MOBILIARIO",
            nome_classe: "Mobiliario",
            tipo_controle: "INDIVIDUAL",
            tombavel: true,
            codigo_grupo_patrimonial: "MOBILIARIO",
            permite_manutencao_corretiva: false,
            permite_manutencao_preventiva: false,
            permite_recondicionamento: false,
            permite_substituicao: false,
            ativo: false
          },
          {
            codigo_material: "MAT-MONITOR",
            nome_material: "Monitor",
            codigo_classe: "INFORMATICA",
            nome_classe: "Informatica",
            tipo_controle: "INDIVIDUAL",
            tombavel: true,
            codigo_grupo_patrimonial: "EQUIPAMENTO",
            permite_manutencao_corretiva: true,
            permite_manutencao_preventiva: true,
            permite_recondicionamento: true,
            permite_substituicao: true,
            ativo: true
          },
          {
            codigo_material: "MAT-TECLADO",
            nome_material: "Teclado",
            codigo_classe: "INFORMATICA",
            nome_classe: "Informatica",
            tipo_controle: "INDIVIDUAL",
            tombavel: true,
            codigo_grupo_patrimonial: "EQUIPAMENTO",
            permite_manutencao_corretiva: false,
            permite_manutencao_preventiva: false,
            permite_recondicionamento: false,
            permite_substituicao: false,
            ativo: true
          }
        ],
        configuracoes: [
          {
            codigo_configuracao: "CFG-KIT-LABORATORIO",
            nome_configuracao: "Kit Laboratorio",
            tipo_configuracao: "KIT",
            ativo: false
          },
          {
            codigo_configuracao: configuration.code,
            nome_configuracao: "Microcomputador Tipo VI",
            tipo_configuracao: "COMPOSTO",
            ativo: true
          }
        ],
        componentes: [
          {
            codigo_configuracao: configuration.code,
            codigo_material_singular: "MAT-MONITOR",
            quantidade: 1
          },
          {
            codigo_configuracao: configuration.code,
            codigo_material_singular: "MAT-TECLADO",
            quantidade: 1
          }
        ]
      });
    } finally {
      await prisma.$disconnect().catch(() => undefined);
      await postgres.stop();
    }
  });
});
