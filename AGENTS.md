# AGENTS.md — GESTOR GMAP

## Missão

Implemente o GESTOR GMAP de forma incremental, preservando as especificações em `docs/specs` e evitando overengineering.

Este projeto usa Codex CLI com **agente principal orquestrador e subagentes**.

## Regra central de orquestração

O agente principal deve **delegar trabalho sempre que a tarefa puder ser separada com segurança**, mas cada subagente deve receber **uma tarefa curta, clara, verificável e com escopo de escrita explícito**.

Nunca delegue uma fase inteira ou um Bounded Context inteiro em uma única tarefa.

O agente principal é responsável por:

- entender a solicitação do usuário;
- ler os specs necessários;
- decompor o trabalho;
- definir dependências;
- atribuir escopos de arquivos sem colisão;
- integrar resultados;
- revisar diffs;
- executar a verificação final;
- manter coerência arquitetural e de domínio.

## Como delegar

Para toda tarefa de subagente, informe:

```text
OBJETIVO
Uma única entrega concreta.

ARQUIVOS/Pastas permitidos
Escopo de leitura e escrita.

NÃO ALTERAR
Arquivos/pastas fora do escopo.

REGRAS RELEVANTES
Somente o contexto necessário dos specs.

CRITÉRIOS DE ACEITE
Resultados verificáveis.

VALIDAÇÃO
Comandos/testes a executar.

RETORNO
Resumo curto + arquivos alterados + testes + risco/pendência.
```

## Tamanho das tarefas

Prefira tarefas como:

- “implementar Value Object Tombo e testes unitários”;
- “criar Query de listagem paginada de Patrimônio”;
- “adicionar migration Prisma para TeamMembership”;
- “escrever testes de concorrência para reserva de estoque”;
- “criar adapter S3 para FileStorage”;
- “revisar autorização do Command RetombarPatrimonio”.

Evite tarefas como:

- “implementar Patrimônio”;
- “fazer todo o backend”;
- “implementar a Fase 6”;
- “resolver todas as pendências”.

## Paralelismo

Pode usar subagentes em paralelo somente quando os escopos de escrita forem disjuntos.

Preferência operacional: até 2–3 subagentes independentes de cada vez.

Não permita que dois agentes alterem simultaneamente:

- `prisma/schema.prisma`;
- o mesmo Aggregate;
- o mesmo arquivo de configuração central;
- a mesma migration;
- o mesmo contrato OpenAPI.

Arquivos compartilhados ficam sob responsabilidade do agente principal ou são alterados em tarefas serializadas.

## Papéis úteis de subagentes

### Explorer
Read-only sempre que possível. Mapeia código, dependências, specs e riscos.

### Domain/Test Agent
Usa TDD em regras e Commands críticos. Foca em invariantes e testes.

### Implementation Agent
Implementa uma mudança pequena e isolada.

### Query/Reporting Agent
Foca em queries, projections, paginação e performance de leitura.

### Infrastructure Agent
Docker, Coolify, VPS/Linux, CI/CD, Cloudflare R2, PostgreSQL operacional, scripts e observabilidade, sem redefinir o domínio.

### Reviewer Agent
Revisa o diff de outro agente contra critérios de aceite; não confia apenas no resumo do implementador.

## Fluxo de trabalho obrigatório

```text
PLAN
→ DECOMPOSE
→ DELEGATE
→ IMPLEMENT
→ TEST LOCALLY
→ COLLECT RESULTS
→ REVIEW DIFFS
→ INTEGRATE
→ RUN FINAL CHECKS
→ REPORT
```

Para mudanças críticas, use revisão independente por outro subagente ou por testes determinísticos.

## Fonte de verdade

Ordem de prioridade:

1. solicitação atual do usuário;
2. `docs/specs/01-dominio-consolidado.md`;
3. `docs/specs/02-especificacao-tecnica-consolidada.md`;
4. `docs/specs/03-plano-implementacao.md`;
5. `docs/specs/04-fases-implementacao.md`;
6. ADRs;
7. código existente.

Se código existente contradizer specs, não normalize a contradição silenciosamente. Registre a divergência e siga a fonte de maior prioridade.

## Arquitetura

- TypeScript strict;
- Node.js + Next.js;
- REST/JSON + OpenAPI;
- Monólito Modular;
- PostgreSQL;
- Prisma como ORM padrão;
- SQL especializado permitido em consultas/locks quando necessário;
- Transactional Outbox no PostgreSQL;
- Worker Node.js;
- Tailwind CSS;
- Cloudflare R2 para documentos via adapter S3-compatible;
- sessões server-side em PostgreSQL;
- PWA offline somente para Fiscalização/Tombamento relacionado.

Baseline de infraestrutura de PROD:

```text
VPS 1 → Coolify + Traefik + Web/API + Worker + Scheduler
VPS 2 → PostgreSQL PRIMARY nativo
VPS 3 → PostgreSQL STANDBY + Grafana/Loki/Prometheus + contingência
R2    → documentos + backups externos
```

Regras de infraestrutura:

- não adicionar Nginx/Envoy sem ADR e necessidade concreta;
- PostgreSQL PROD não deve ficar publicamente exposto;
- usar rede privada do provedor ou WireGuard entre VPS;
- replicação PostgreSQL não substitui backup;
- failover do banco é manual inicialmente e deve possuir runbook testado;
- Grafana Alloy coleta telemetria; Loki recebe logs; Prometheus métricas; Grafana visualiza;
- observabilidade deve permanecer simples, sem cluster/HA próprio;
- backups e restores devem ser verificáveis, não apenas configurados.

Não introduza sem ADR e necessidade comprovada:

- microserviços;
- Kubernetes;
- Kafka/RabbitMQ;
- Redis obrigatório;
- Elasticsearch;
- Event Sourcing;
- CQRS completo;
- GraphQL/gRPC obrigatório;
- BPM engine;
- Data Warehouse.

## Organização do código

Módulos ricos devem separar conceitualmente:

```text
domain
application
infrastructure
api/adapters
```

Não crie camadas/abstrações sem uso real.

Não crie `GenericRepository<T>` por padrão. Repositories são específicos e seletivos.

Route Handlers Next.js não devem conter regras de negócio complexas.

## Persistência e transações

- PostgreSQL é fonte transacional oficial;
- saldo não é editado diretamente;
- ledger/histórico é específico por domínio;
- Command crítico define transação coerente;
- optimistic locking por padrão onde necessário;
- pessimistic locking para saldo/recurso crítico;
- constraints de banco protegem invariantes estruturais;
- efeitos externos não ficam dentro da transação de negócio.

## TDD e testes

Use TDD como padrão para:

- invariantes;
- Commands críticos;
- autorização;
- saldo/estoque;
- Tombos;
- migração;
- concorrência;
- idempotência;
- sincronização offline.

Testes:

- Vitest para domínio/aplicação;
- PostgreSQL real via Testcontainers para integração;
- Playwright para poucos E2E críticos.

Não use SQLite para substituir PostgreSQL em testes de persistência.

## Segurança

- escopo e autorização sempre impostos no backend;
- Superusuário técnico não recebe competência de negócio automaticamente;
- nunca logar senha, token, cookie ou segredo;
- documentos privados no Cloudflare R2;
- validar uploads;
- cookies HttpOnly/Secure/SameSite em produção;
- usar `correlation_id` em request/event/job/auditoria.

## Read Models e queries

- não carregar Aggregate completo para listagem;
- selecionar apenas campos necessários;
- paginação/ordenação/filtros server-side;
- evitar N+1;
- Reporting nunca modifica domínio;
- Read Models são reconstruíveis;
- consistência eventual só em leitura analítica, nunca em invariantes.

## Migração legada

- somente Superusuário incorpora;
- importação atômica por lote;
- todo lote é validado antes da incorporação;
- qualquer erro rejeita o lote inteiro;
- retornar todos os erros encontrados, não apenas o primeiro;
- fracionamento de lotes é permitido;
- respeitar dependências;
- usar código público estável, não PK interna, nos templates;
- `legacy_record_key` impede duplicação entre lotes;
- não inventar histórico;
- não disparar efeitos atuais ao importar fatos antigos.

## Windows 10 / PowerShell

O desenvolvedor usa Windows 10. Prefira comandos compatíveis com PowerShell.

- use caminhos relativos sempre que possível;
- não presuma Bash disponível;
- não escreva scripts dependentes de `sed`, `awk`, `rm -rf` etc. sem alternativa multiplataforma;
- Docker deve funcionar por Docker Desktop/Compose;
- scripts npm devem ser multiplataforma quando possível.

## Git

O usuário prefere executar Git manualmente via CLI.

Por padrão:

- inspecione `git status` e `git diff`;
- não crie branch;
- não faça commit;
- não faça push;
- não faça merge;
- não descarte alterações existentes;
- não use comandos destrutivos (`reset --hard`, `clean -fd`, checkout que descarte trabalho) sem solicitação explícita.

## Checks

Antes de concluir um incremento, execute os comandos disponíveis equivalentes a:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
```

Execute E2E quando a mudança afetar fluxo crítico.

Se algum script ainda não existir, não invente sucesso; informe e, se estiver no escopo, crie-o.

## Higiene de saída dos subagentes

Subagentes devem evitar despejar logs extensos no agente principal.

Retorno recomendado:

```text
STATUS
ARQUIVOS ALTERADOS
TESTES/COMANDOS + exit status
FALHAS relevantes
RISCO/PENDÊNCIA
```

O agente principal deve validar o diff real antes de aceitar o resultado.

## Definition of Done

Uma tarefa não está pronta apenas porque “a tela funciona”.

Command crítico precisa, conforme aplicável, de:

- regra de domínio;
- autorização/escopo;
- transação;
- concorrência/idempotência;
- auditoria;
- evento/outbox;
- testes;
- erro amigável;
- observabilidade.

Query precisa de:

- escopo;
- campos mínimos;
- paginação/ordenação/filtros;
- performance adequada;
- testes.
