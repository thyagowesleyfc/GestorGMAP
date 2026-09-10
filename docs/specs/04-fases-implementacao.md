# GESTOR GMAP — Fases de Implementação
## Roadmap técnico e funcional incremental

> Cada fase é composta por incrementos pequenos. O Codex principal deve delegar tarefas independentes a subagentes conforme `AGENTS.md` e nunca pedir a um subagente para “implementar a fase inteira”.

---

## Fase 0 — Fundação do repositório

### Objetivo
Projeto executável, testável e implantável em DEV/HML sem regra de negócio relevante.

### Entregas

- Next.js + TypeScript strict + npm;
- Tailwind CSS;
- ESLint + formatter;
- Prisma + PostgreSQL;
- Docker Compose DEV;
- estrutura modular inicial;
- Vitest;
- Testcontainers;
- Playwright básico;
- OpenAPI baseline;
- health/readiness endpoints;
- correlation id e logging estruturado mínimo;
- CI inicial;
- ADRs iniciais;
- `AGENTS.md`.

### Tarefas curtas sugeridas para subagentes

1. criar configuração lint/format/typecheck;
2. criar Docker Compose PostgreSQL;
3. configurar Vitest/Testcontainers;
4. criar health checks;
5. documentar estrutura modular;
6. criar pipeline CI inicial.

### Gate

```text
npm ci
lint OK
typecheck OK
tests OK
build OK
PostgreSQL DEV sobe pelo Docker
```

---

## Fase 1 — IAM, Organização, sessão e segurança base

### Objetivo
Entrar no sistema, manter sessão e aplicar Time/Membership/Escopo no backend.

### Entregas

- User/Pessoa;
- autenticação própria;
- hash de senha/recuperação;
- Session em PostgreSQL;
- cookies seguros;
- Team/TeamMembership;
- MEMBRO/LÍDER;
- GLOBAL/GRE;
- Superusuário técnico;
- revogação de sessão;
- visualização de sessões ativas;
- uma aba operacional ativa (UX);
- rate limiting de login/recuperação;
- audit/log baseline.

### Subagentes

- domínio IAM + testes;
- adapter de sessão;
- UI login/sessões;
- revisor de autorização/segurança.

### Gate

Teste matricial de autorização cobre usuário ativo/inativo, Time, Líder, Gerência, Superusuário e GRE.

---

## Fase 2 — Catálogo e Entidades

### Objetivo
Criar a base canônica usada por todos os contextos e pelos templates de migração.

### Entregas

- Classes;
- Materiais Singulares;
- Kit/Composto e configuração;
- flags de controle/tombabilidade/manutenção;
- Entidades e hierarquia atual;
- Município/GRE;
- códigos públicos estáveis;
- consultas e exports auxiliares `materiais_gmap.xlsx` e `entidades_gmap.xlsx`.

### Gate

Não há criação automática de Material/Entidade pelo importador legado.

---

## Fase 3 — Contratos, Itens Contratuais e OF

### Objetivo
Controlar aquisição e comprometimento de saldo contratual.

### Entregas

- Fornecedor;
- Contrato/Item;
- Aditivo/Apostilamento;
- designações Gestor/Fiscal descritivas;
- ledger de saldo contratual;
- posição atual de saldo;
- OF e itens;
- autorização/cancelamento;
- optimistic/pessimistic locking necessário;
- idempotência de emissão/cancelamento;
- extrato básico do Contrato.

### Gate

Teste concorrente prova que duas OFs não comprometem saldo acima do disponível.

---

## Fase 4 — Receiving e Stock

### Objetivo
Registrar fatos físicos e controlar saldo sem edição direta.

### Entregas

- Entrada/ItemEntrada;
- NF e documentos aplicáveis;
- regularização por item;
- origem contratual/indenizatória/pendente;
- `MovimentoEstoque` append-only;
- `PosicaoEstoque`;
- reserva;
- separação;
- devolução;
- locks de disponibilidade;
- auditoria.

### Gate

Teste concorrente:

```text
saldo disponível = 10
2 reservas simultâneas de 10
→ apenas uma conclui
→ saldo nunca fica negativo
```

---

## Fase 5 — Solicitações e Logística

### Objetivo
Fechar o ciclo Solicitação → autorização → atendimento → Entrega/Recolha.

### Entregas

- Solicitação de Materiais;
- referências SEI/Redmine 0..N;
- workflow de Triagem/Gerência;
- autorização parcial;
- Expedição;
- Entrega e aceite total/parcial/recusa;
- Recolha;
- notificações internas;
- e-mail assíncrono via Outbox;
- documentos de entrega.

### Gate

Falha de e-mail não reverte Entrega e gera retry/FAILED conforme política.

---

## Fase 6 — Patrimônio, Tombos e Movimentações

### Objetivo
Construir o núcleo de identidade e ciclo patrimonial.

### Entregas

- Patrimônio com ID estável;
- incorporação após aceite;
- Tombo único;
- geração segura de sequência;
- composição concreta;
- retificação;
- retombamento;
- Remanejamento;
- Empréstimo;
- Recolha patrimonial;
- Baixa;
- histórico/timeline inicial;
- inventário por Entidade.

### Gate

Testes obrigatórios:

- Tombo duplicado nunca passa;
- retombamento é atômico;
- antigo Tombo nunca é reutilizado;
- Superusuário sem Membership não executa autoridade de negócio.

---

## Fase 7 — Manutenção e OS

### Objetivo
Fechar manutenção interna/externa, garantia e efeitos contratuais.

### Entregas

- Solicitação de Manutenção;
- estratégia de atendimento;
- UTD/CERME como atores externos;
- Laudo versionado;
- Contrato de Serviço;
- OS;
- ateste;
- glosa;
- SLA;
- preventiva básica;
- substituição de componente;
- substituição integral em garantia;
- efeitos patrimoniais e contratuais.

### Gate

OS emitida é imutável; glosa restitui apenas saldo correspondente; irrecuperável não baixa automaticamente.

---

## Fase 8 — Reporting e Read Models

### Objetivo
Entregar consultas analíticas sem acoplar UI a Aggregates completos.

### Entregas

- infrastructure de projections;
- Dashboard;
- Entity360;
- PatrimonyTimeline completa;
- InventoryPosition;
- StockPosition;
- métricas oficiais;
- paginação/ordenação/filtros server-side;
- exportações PDF/XLSX/CSV;
- jobs para exportação pesada.

### Gate

Cards e drill-down usam a mesma definição de métrica. Read Models são reconstruíveis.

---

## Fase 9 — Fiscalização online

### Objetivo
Implementar o processo completo de conferência antes do modo offline.

### Entregas

- FiscalizacaoPatrimonial;
- Conferencia por Entidade;
- versão de referência;
- resultados de conferência;
- divergências;
- Termo;
- regularização/encerramento;
- evidências/fotos conforme regra;
- scanner por Tombo quando online.

### Gate

Fiscalização constata; não altera estruturalmente Patrimônio de forma indevida.

---

## Fase 10 — PWA e Fiscalização offline

### Objetivo
Permitir visita de campo com conectividade intermitente curta.

### Entregas

- PWA;
- Service Worker;
- IndexedDB;
- pacote mínimo offline;
- expiração de pacote;
- UUID por operação local;
- `observed_at`/`synced_at`;
- fila local;
- sync em lotes;
- idempotência;
- `SYNC_ERROR` x `RECONCILIATION_REQUIRED`;
- fotos comprimidas e envio ao Cloudflare R2 por adapter S3-compatible;
- limpeza local após encerramento.

### Gate

Movimento oficial online posterior nunca é sobrescrito por observação offline antiga.

---

## Fase 11 — Framework de Migração Legada

> O framework pode começar antes, mas a incorporação de cada domínio só ocorre quando o módulo alvo já está estável.

### Objetivo
Migrar 50–200 mil registros em lotes auditáveis e atômicos.

### Entregas

- `MigrationBatch`;
- upload XLSX/CSV;
- staging;
- validadores;
- dry-run;
- relatório completo de inconsistências;
- confirmação Superusuário;
- anti-duplicação por `legacy_record_key`;
- templates auxiliares;
- importadores de Contrato/OF/OS/Entrada/Envio/Patrimônio;
- métricas técnicas da execução;
- auditoria.

### Estratégia

Importações podem ser fracionadas:

```text
Entradas 2023
Entradas 2024
Envios GRE 01
Patrimônios lote 001
...
```

Cada lote é independente e atômico. Dependências já incorporadas são verificadas.

### Gate

Qualquer erro do lote implica zero incorporações daquele lote e relatório com todas as inconsistências detectáveis.

---

## Fase 12 — Hardening, HML e produção

### Objetivo
Preparar operação real e rollout progressivo.

### Entregas

- provisionamento/documentação das 3 VPS Linux;
- VPS 1 com Coolify + Traefik + Web/API + Worker + Scheduler;
- VPS 2 com PostgreSQL PRIMARY nativo;
- VPS 3 com PostgreSQL STANDBY e capacidade de contingência;
- rede privada entre VPS ou WireGuard;
- firewall e PostgreSQL sem exposição pública;
- Cloudflare DNS;
- Cloudflare R2 privado para documentos e backups;
- streaming replication PostgreSQL;
- procedimento manual de failover/promote;
- Grafana + Loki + Prometheus + Alloy;
- secrets;
- health checks;
- logs/métricas/alertas;
- backup externo diário e retenção;
- restore testado;
- CI/CD `homolog → main` integrado ao Coolify;
- migrations de deploy;
- smoke tests;
- runbooks de rollback/restore/failover;
- teste de RTO;
- validação de RPO;
- feature flags seletivas.

### Gate

- HML funcional;
- deploy reproduzível via Git/Coolify;
- PostgreSQL primary/standby saudável e replication lag monitorado;
- restore de backup R2 validado;
- failover manual ensaiado em HML;
- indisponibilidade recuperável dentro do alvo operacional planejado;
- observabilidade ativa e protegida.

---

## Fase 13 — Rollout operacional

### Objetivo
Introduzir o GMAP na rotina sem Big Bang.

Ordem sugerida de ativação:

```text
1. IAM / Catálogo / Entidades
2. Contratos / OF
3. Receiving / Stock
4. Solicitações / Logística
5. Patrimônio
6. Manutenção
7. Reporting
8. Fiscalização online
9. Fiscalização offline
10. ondas de migração legado conforme contexto
```

A ordem pode ser ajustada por operação real, mantendo dependências.

---

## Checkpoint de cada fase

Antes de avançar:

```text
[ ] critérios de aceite atendidos
[ ] lint
[ ] typecheck
[ ] unit tests
[ ] integration tests relevantes
[ ] E2E crítico quando aplicável
[ ] build
[ ] migrations validadas
[ ] ADR/docs atualizados
[ ] nenhum OPEN-QUESTION bloqueante oculto
[ ] git diff revisado pelo agente principal
```
