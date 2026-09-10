# GESTOR GMAP — Especificação Técnica Consolidada
## Pós-Rodadas Técnicas 1–8

## 1. Princípios

1. Complexidade de domínio alta; escala computacional inicial moderada.
2. Consistência, histórico e rastreabilidade têm prioridade sobre sofisticação distribuída.
3. Monólito Modular inicialmente.
4. PostgreSQL é a fonte transacional oficial.
5. Um módulo não altera diretamente dados de propriedade de outro módulo.
6. Comandos críticos possuem fronteira transacional explícita.
7. Efeitos secundários ficam fora da transação principal.
8. Domain Events internos não implicam Kafka/broker.
9. Read Models são reconstruíveis e nunca segunda fonte de verdade.
10. Open/Closed deve orientar extensões, sem abstrações especulativas.

---

## 2. Stack baseline

```text
TypeScript
Node.js 24 LTS
Next.js (App Router)
React
Tailwind CSS
npm
REST / JSON
OpenAPI
Prisma ORM
PostgreSQL
Vitest
Testcontainers + PostgreSQL
Playwright
Docker / Docker Compose
Coolify
Traefik
Cloudflare R2
Grafana + Loki + Prometheus + Alloy
```

As versões exatas devem ser fixadas no bootstrap e atualizadas de forma controlada.

---

## 3. Arquitetura geral

```text
Internet
  ↓
Cloudflare DNS
  ↓
VPS 1 — Aplicação
  ├── Coolify
  ├── Traefik
  ├── Next.js / Node.js
  │    ├── Web
  │    └── REST API
  ├── Worker Node.js
  └── Scheduler lógico
         │
         │ rede privada / WireGuard
         ▼
VPS 2 — Dados
  └── PostgreSQL PRIMARY
         │
         │ streaming replication
         ▼
VPS 3 — Recuperação / Observabilidade
  ├── PostgreSQL STANDBY
  ├── Grafana
  ├── Loki
  ├── Prometheus
  └── capacidade de contingência da aplicação

Grafana Alloy
  → coleta telemetria das VPS 1, 2 e 3

Cloudflare R2
  ├── documentos privados
  └── backups externos
```

Backend é uma única aplicação lógica/modular. API e Worker podem ser processos diferentes da mesma release/código.

Não usar inicialmente microserviços, Kubernetes, Kafka, RabbitMQ, Redis obrigatório, Elasticsearch, GraphQL obrigatório, Event Sourcing, CQRS completo, BPM Engine ou Data Warehouse.

---

## 4. Módulos físicos

```text
src/
├── app/                    # interface Next.js / Route Handlers
├── modules/
│   ├── organization/
│   ├── catalog/
│   ├── entities/
│   ├── requests/
│   ├── contracts/
│   ├── receiving/
│   ├── stock/
│   ├── logistics/
│   ├── patrimony/
│   ├── maintenance/
│   ├── inspection/
│   ├── reporting/
│   └── integrations/
├── shared/
└── worker/

prisma/
tests/
docs/
```

Estrutura interna recomendada para módulos ricos:

```text
module/
├── domain/
├── application/
├── infrastructure/
└── api/ ou adapters/
```

CRUD simples não precisa de DDD cerimonial.

---

## 5. Propriedade dos dados

Mesmo com banco físico único:

- cada módulo possui suas tabelas/entidades lógicas;
- módulo externo não faz `UPDATE` direto nas tabelas proprietárias;
- escrita cruza fronteiras por Command/Application Service/API interna;
- Reporting pode ler transversalmente, nunca corrigir estado.

---

## 6. PostgreSQL e Prisma

Prisma é o ORM padrão para:

- persistência comum;
- relações;
- migrations;
- transactions;
- CRUD;
- queries normais.

SQL especializado/TypedSQL/raw é permitido e esperado para:

- `SELECT ... FOR UPDATE` e locking específico;
- reporting pesado;
- agregações;
- bulk operations;
- queries que o Prisma não represente adequadamente.

Prisma implementa a persistência; não define o domínio.

Repositories são **seletivos**, por Aggregate quando agregarem valor. Não criar `GenericRepository<T>` obrigatório.

---

## 7. Transações e Unit of Work

Cada Command crítico define uma fronteira atômica:

```text
Command Handler
→ valida autorização e invariantes
→ abre transação
→ altera fatos essenciais
→ registra auditoria/evento/outbox necessário
→ commit ou rollback
```

Usar o mecanismo nativo do Prisma/PostgreSQL; não criar transaction manager próprio sem necessidade.

Consequência necessária à validade do fato pode participar da mesma transação. Consequência derivada/externa ocorre após commit.

---

## 8. Concorrência

Estratégia híbrida:

### Optimistic locking — padrão

Aggregates relevantes possuem versão. Operação falha se versão mudou desde a leitura.

### Pessimistic locking — invariantes quantitativas críticas

Aplicar `FOR UPDATE`/equivalente em operações como:

- reserva/separação de estoque;
- comprometimento de saldo contratual;
- geração/alocação de sequências quando necessário.

### Constraints de banco

Proteção redundante de invariantes estruturais:

- Tombo `UNIQUE`;
- referências obrigatórias;
- checks quantitativos aplicáveis;
- unicidades naturais.

---

## 9. Ledgers e posições atuais

Não existe ledger universal.

Históricos semânticos próprios:

```text
MovimentoEstoque
MovimentoPatrimonial
MovimentoSaldoContratual
HistoricoTombo
ExecucaoOS
...
```

Para Estoque e saldo contratual:

```text
Ledger imutável
→ verdade histórica

Posição atual
→ projeção operacional otimizada
```

Posição nunca substitui o histórico que a originou.

---

## 10. Domain Events, Outbox e Jobs

Domain Event representa algo ocorrido no domínio; Auditoria tem finalidade distinta.

Transactional Outbox no PostgreSQL:

```text
outbox_event
- id
- event_type
- aggregate_type
- aggregate_id
- payload
- created_at
- processed_at
- attempts
- next_attempt_at
- last_error
```

Transação de negócio grava fato + Outbox. Worker processa após commit.

Sem broker externo inicialmente.

### Retry

- backoff crescente;
- limite de tentativas;
- após limite, `FAILED`;
- Superusuário pode reprocessar;
- operador recebe notificação apenas quando houver ação de negócio necessária.

Jobs sujeitos a retry devem ser idempotentes.

---

## 11. Worker e Scheduler

Worker Node.js usa PostgreSQL como fila durável inicial.

```text
loop
→ busca lote com lock seguro
→ executa
→ registra sucesso/falha
```

Projeto deve permitir múltiplos Workers no futuro sem processamento duplicado.

Scheduler inicial: processo lógico único no Worker. Pode ser executado como processo/container dedicado. A infraestrutura pode mudar futuramente sem alterar regra de negócio.

---

## 12. Notificações e E-mail

Notificação interna é conceito separado de Domain Event.

Targets:

```text
USER
TIME
LIDER
GERENCIA
```

Estados simples:

```text
CRIADA
LIDA
ARQUIVADA
RESOLVIDA (quando houver ação)
```

E-mail é efeito secundário:

```text
Domain Event
→ Outbox
→ Worker
→ EmailSender
→ Provider Adapter
```

`EmailSender` é port; provedores são adapters. Novo provedor exige novo adapter, não alteração do domínio.

Logs técnicos podem guardar `provider_message_id`, tentativas e erro; domínio guarda resultado comunicacional relevante.

---

## 13. Documentos e Object Storage

PostgreSQL mantém metadados; **Cloudflare R2** mantém os bytes. A Application Layer depende de uma porta abstrata de storage; a infraestrutura usa adapter compatível com API S3.

```text
FileStorage / ObjectStorage
        ↓
S3CompatibleStorageAdapter
        ↓
Cloudflare R2
```

```text
Documento
- id
- tipo
- nome
- content_type
- tamanho
- storage_key
- sha256
- origem
- data
- usuario
```

R2:

- buckets separados por ambiente;
- privados;
- credenciais separadas por ambiente;
- download autorizado pelo GMAP, preferencialmente por URL assinada temporária;
- nenhuma regra de domínio depende do provedor de object storage.

Versionamento de domínio é seletivo por tipo de Documento. Proteções técnicas do storage não substituem o versionamento de negócio.

---

## 14. Referências externas

SEI/Redmine inicialmente são somente `ExternalReference`:

```text
system
type
identifier
url opcional
```

Identidade: `system + identifier`.

Sem sincronização automática na primeira fase. Futuramente adapters/ACL podem ser adicionados.

---

## 15. Reporting e Read Models

Consultas simples usam o modelo transacional quando apropriado.

Consultas transversais/analíticas usam Read Models no mesmo PostgreSQL inicialmente.

Atualização de Read Models analíticos é assíncrona por Outbox/Worker; consistência eventual é aceitável para análise, nunca para invariantes críticas.

Read Models principais:

```text
Dashboard
Entity360
PatrimonyTimeline
InventoryPosition
StockPosition
RequestMetrics
MaintenanceMetrics
InspectionMetrics
```

Read Model é reconstruível e não contém dado editável exclusivo.

### Consultas

- paginação server-side;
- ordenação server-side;
- filtros padronizados;
- seleção apenas dos campos necessários;
- evitar N+1;
- queries especializadas/SQL quando necessário;
- índices orientados a casos de uso e medição.

Pesquisa textual inicial no PostgreSQL (`ILIKE`, trigram/full-text conforme necessidade). Identificadores como Tombo, SEI, Redmine e códigos usam busca exata/indexada.

Sem Redis/Elasticsearch inicial, mesmo com 50–200 mil registros, salvo evidência de gargalo real.

### Histórico

Reconstrução histórica por movimentos inicialmente. Snapshots históricos só se desempenho medido justificar.

---

## 16. IAM e autenticação

Autenticação própria inicialmente; SSO futuro possível via adapter.

```text
User
→ TeamMembership
→ Team
→ MEMBRO | LIDER
→ GLOBAL | GRE
```

Sessão server-side em PostgreSQL + cookie `HttpOnly`, `Secure`, `SameSite`.

Senhas: hash forte (ex.: Argon2id ou equivalente da stack), recuperação e revogação de sessões após reset.

Múltiplas sessões em dispositivos diferentes são permitidas e visíveis/administráveis.

Uma única aba operacional ativa por sessão do navegador é regra de UX, não consistência/segurança.

### Autorização em camadas

```text
Autenticado?
Ativo?
Membership?
Papel?
Escopo?
Autorização/Validação necessária?
Estado permite?
Invariantes satisfeitas?
```

Middleware protege borda; Application/Domain protege regra crítica.

Escopo é imposto no backend também em Queries.

Superusuário técnico não ganha competência de negócio automaticamente.

---

## 17. Segurança web

Obrigatório:

- TLS/HTTPS;
- CSRF;
- mitigação XSS;
- CORS controlado;
- headers seguros;
- validação de input;
- uploads com limite, MIME, extensão e nome;
- rate limit em login/recuperação;
- nenhum segredo/token/senha em logs.

`correlation_id` transversal liga request, auditoria, eventos e jobs.

---

## 18. Auditoria

`AuditEntry` append-only conceitual:

```text
id
timestamp
usuario
time/contexto
acao
tipo_objeto
objeto_id
valor_anterior
valor_posterior
motivo
correlation_id
```

Não copiar objetos gigantes sem necessidade; registrar diferenças relevantes.

Auditoria não substitui histórico semântico do domínio.

Registros usados em fatos não são fisicamente apagados; usar INATIVO/CANCELADO/ENCERRADO conforme conceito.

---

## 19. Idempotência

Comandos críticos recebem `CommandId`/`Idempotency-Key`.

Retry com mesma chave retorna/recupera o resultado anterior sem duplicar operação.

Aplicar a:

- emissão/cancelamento de OF/OS;
- operações patrimoniais críticas;
- sync offline;
- jobs assíncronos;
- demais comandos com risco real de duplicação.

CRUD trivial não exige idempotência especial.

---

## 20. PWA e Fiscalização offline

Offline somente para:

- Fiscalização Patrimonial;
- Tombamento físico relacionado.

PWA usa armazenamento local estruturado (IndexedDB) temporário.

Pacote mínimo:

```text
Entidade
Fiscalização
Inventário esperado
Patrimônios/Tombos
Materiais/composições necessárias
Quantitativos
Versão de referência
```

Fiscal precisa estar online para login, autorização e download inicial. Offline não cria nova Fiscalização nem amplia escopo.

Cada operação local recebe UUID. Datas:

```text
observed_at
synced_at
```

Conflito com estado posterior gera `RECONCILIATION_REQUIRED`, não rollback/sobrescrita.

Estados técnicos locais:

```text
SALVO_NO_DISPOSITIVO
AGUARDANDO_SINCRONIZACAO
SINCRONIZADO
ERRO_DE_SINCRONIZACAO
REQUER_RECONCILIACAO
```

Dados locais são removidos após sincronização/encerramento. Modo offline é contingência curta; sincronização deve ocorrer assim que possível.

---

## 21. Migração técnica

Volume previsto: aproximadamente 50–200 mil registros.

### Fases

1. ETL/saneamento externo;
2. staging técnico;
3. validação completa;
4. dry-run;
5. confirmação do Superusuário;
6. incorporação atômica do lote.

Staging não pertence ao domínio.

Templates oficiais: XLSX; CSV pode ser aceito tecnicamente para volume.

Importadores separados por domínio:

```text
contratos
of
os
entradas
envios
patrimonios
```

Cada lote possui `MigrationBatch`. Atomicidade é por lote; fracionamento é permitido, respeitando dependências.

Cada registro legado deve possuir chave estável de origem (`legacy_record_key`) para anti-duplicação entre lotes, sem virar identidade do Aggregate.

Antes de grandes ondas de migração em produção, criar snapshot/backup identificável. PITR continua proteção contínua.

---

## 22. Testes e TDD

TDD é prática padrão para:

- regras de domínio;
- Commands críticos;
- Policies/autorização;
- Estoque/saldos;
- Tombos;
- migração;
- concorrência;
- sincronização offline.

Não aplicar TDD dogmaticamente a markup trivial.

### Pirâmide

```text
Vitest
→ unit/domain/application

Vitest + Testcontainers + PostgreSQL real
→ integration/Prisma/transactions/locking/migrations/outbox

Playwright
→ poucos fluxos E2E críticos
```

Obrigatórios testes de concorrência, autorização, migração e idempotência.

Não usar SQLite como substituto de PostgreSQL em testes de integração.

---

## 23. Docker e ambientes

Ambientes:

```text
DEV
HML
PROD
```

DEV: Windows 10 + Docker Desktop/Docker Compose.

HML e PROD usam credenciais, bancos e buckets distintos. Dados reais de PROD não são copiados livremente para DEV/HML.

Baseline de banco:

```text
DEV  → PostgreSQL em Docker local
HML  → PostgreSQL isolado de homologação
PROD → PostgreSQL nativo na VPS 2 + standby na VPS 3
```

Mesma base de código/release para Web/API, Worker e Scheduler; processos/containers distintos quando necessário.

---

## 24. Infraestrutura self-hosted em 3 VPS

A infraestrutura oficial é self-hosted, com três VPS Linux e serviços externos apenas quando simplificam durabilidade/edge.

### VPS 1 — Aplicação

```text
Ubuntu/Linux
Coolify
Traefik (proxy padrão)
Docker
├── GMAP Web/API
├── GMAP Worker
└── GMAP Scheduler
```

Coolify gerencia deploy, variáveis/secrets de aplicação, containers, domínios e TLS. Não adicionar Nginx ou Envoy inicialmente sem necessidade concreta; Traefik atende o reverse proxy HTTP/HTTPS da baseline.

### VPS 2 — Dados

```text
PostgreSQL PRIMARY
→ instalação nativa no host
→ acesso restrito à rede privada
→ sem exposição pública direta
```

A aplicação acessa PostgreSQL por rede privada do provedor ou túnel WireGuard. Firewall deve permitir somente origens/portas necessárias.

### VPS 3 — Recuperação e observabilidade

```text
PostgreSQL STANDBY
Grafana
Prometheus
Loki
capacidade de contingência para Web/API/Worker
```

O standby recebe **streaming replication** do primary. Failover é inicialmente manual e documentado; não introduzir Patroni/etcd/Consul ou cluster HA automático sem necessidade comprovada.

### Grafana Alloy

Alloy coleta logs/métricas/telemetria nas VPS e encaminha aos componentes de observabilidade. Preferir instalação/execução simples por host.

### Cloudflare

```text
Cloudflare DNS
Cloudflare R2
├── documentos do GMAP
└── backups externos
```

R2 é acessado por adapter S3-compatible e permanece fora das VPS, reduzindo risco de perda conjunta com o host.

### RPO/RTO

- RPO de negócio tolerável: **até 24h** em cenário de desastre amplo;
- streaming replication reduz a perda provável em falha isolada do primary, mas **replicação não é backup**;
- backup externo diário no R2, com retenção operacional definida e teste periódico de restauração;
- backup extraordinário antes de ondas grandes de migração ou mudanças críticas;
- RTO alvo durante expediente: **até 30 minutos** para falhas operacionais e failover previsto;
- perda simultânea de múltiplas VPS é cenário de desastre e deve possuir runbook de recuperação, sem promessa artificial de zero downtime;
- disponibilidade boa durante expediente; zero downtime absoluto não é requisito.

### Failover PostgreSQL inicial

```text
1. confirmar indisponibilidade do PRIMARY
2. promover STANDBY na VPS 3
3. atualizar endpoint/configuração interna de banco
4. reiniciar/reconectar serviços da aplicação
5. executar health/smoke checks
6. registrar incidente e reconstruir novo standby depois
```

O procedimento deve ser ensaiado em HML antes de PROD.

### Contingência da aplicação

Nada essencial deve existir apenas no filesystem da VPS 1. Em perda total dessa VPS, o runbook deve permitir subir Web/API/Worker temporariamente na VPS 3 ou em VPS substituta usando imagem/configuração versionadas e restauráveis.

---

## 25. Observabilidade

A baseline é simples/single-node; não criar cluster de observabilidade.

### Logs estruturados

```text
timestamp
level
service
environment
correlation_id
user_id quando aplicável
event
message
```

Fluxo principal:

```text
Aplicação/hosts
→ Grafana Alloy
→ Loki
→ Grafana
```

### Métricas

Prometheus coleta/recebe métricas e Grafana as visualiza. Monitorar ao menos:

- requests/latência/HTTP 5xx;
- jobs pendentes/FAILED;
- idade e volume da Outbox;
- heartbeat do Worker;
- CPU/memória/disco das VPS;
- conexões/locks/queries lentas do PostgreSQL;
- replication lag do standby;
- health do R2 e falhas de backup.

### Alertas técnicos

Vão para Superusuário/operação técnica, separados de alertas de negócio.

Health checks: liveness/readiness e checks operacionais para Worker, banco, replicação e backup.

Grafana/Loki/Prometheus não ficam expostos publicamente sem proteção de acesso.

Erro de domínio é amigável e específico; erro técnico não expõe detalhe interno ao usuário e registra `correlation_id`.

---

## 26. CI/CD e Git

Repositório remoto privado é necessário para automação.

Workflow:

```text
feature/*
→ PR
→ homolog
→ CI
→ HML
→ validação
→ main
→ CI/CD
→ PROD
```

`homolog` e `main` protegidas; CI obrigatório.

Hotfix:

```text
hotfix/*
→ homolog/teste
→ main
```

Build identifica commit/versão. Idealmente o mesmo artefato testado em HML é promovido para PROD.

Pipeline mínimo:

- format;
- ESLint;
- TypeScript check;
- testes;
- migration validation;
- build;
- imagem Docker;
- deploy.

Migrations de schema são versionadas e executadas uma vez antes de subir nova versão; falha bloqueia deploy.

---

## 27. Feature flags e seeds

Feature flags simples e seletivas na camada Application/Infrastructure. Podem ocultar funcionalidades em rollout, nunca desligar invariantes.

Exemplos válidos:

```text
FISCALIZACAO_OFFLINE
MANUTENCAO_PREVENTIVA
```

Exemplo proibido:

```text
VALIDAR_TOMBO_UNICO=false
```

Seed versionado/idempotente somente para dados estruturais, como Times e competências iniciais. Materiais, Entidades, Contratos e Patrimônios são dados de negócio e entram por cadastro/migração.

---

## 28. ADRs e documentação

Manter ADRs curtos:

```text
ADR-001 Monólito Modular
ADR-002 PostgreSQL
ADR-003 Prisma com escape para SQL especializado
ADR-004 Transactional Outbox
ADR-005 Cloudflare R2 / storage S3-compatible para documentos
ADR-006 Sessão server-side
ADR-007 PWA offline seletiva
ADR-008 Infraestrutura self-hosted com 3 VPS + Coolify/Traefik
ADR-009 PostgreSQL primary/standby com failover manual
ADR-010 Observabilidade Grafana/Loki/Prometheus/Alloy
```

API REST deve possuir contrato OpenAPI.

---

## 29. Definition of Done

### Command crítico

- regra implementada;
- autorização/escopo;
- transação correta;
- auditoria;
- evento/outbox quando necessário;
- concorrência/idempotência quando aplicável;
- testes;
- logs/correlation id;
- erro amigável;
- documentação relevante atualizada.

### Query

- escopo;
- campos mínimos;
- filtros/ordenação;
- paginação;
- índices/performance razoável;
- testes;
- mesma semântica da exportação/métrica.

---

## 30. Decisões explicitamente rejeitadas na primeira arquitetura

```text
Microserviços
Kubernetes
Kafka
RabbitMQ
Redis obrigatório
Elasticsearch
GraphQL obrigatório
gRPC obrigatório
Event Sourcing
CQRS completo
BPM Engine
motor genérico de autorização
SSO obrigatório
SEI automático
Redmine automático
aplicativo mobile nativo
Data Warehouse inicial
banco por Bounded Context
edição livre de status críticos
```

Podem ser revisitadas apenas mediante necessidade concreta e ADR correspondente.
