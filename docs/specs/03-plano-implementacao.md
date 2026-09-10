# GESTOR GMAP — Plano de Implementação
## Execução incremental com Codex CLI e subagentes

## 1. Objetivo

Implementar o GMAP sem transformar a especificação completa em uma alteração monolítica.

Princípio:

> **O agente principal coordena; subagentes recebem tarefas curtas, independentes, verificáveis e com escopo de arquivos explícito.**

Cada incremento deve terminar em estado executável e testado.

---

## 2. Ambiente do desenvolvedor

Plataforma principal: **Windows 10 + PowerShell + Codex CLI + Git + Docker Desktop**.

Comandos/documentação devem priorizar PowerShell e caminhos relativos ao repositório.

Exemplo de bootstrap:

```powershell
git status
npm ci
docker compose up -d postgres
npm run lint
npm run typecheck
npm test
npm run build
```

Evitar scripts que só funcionem em Bash quando houver alternativa multiplataforma.

---

## 3. Regras de execução do agente principal

O agente principal é o **orquestrador e integrador final**.

Antes de implementar:

1. ler `AGENTS.md` e `docs/specs`;
2. inspecionar `git status` e código existente;
3. localizar a fase/tarefa atual;
4. decompor em tarefas pequenas;
5. identificar dependências e arquivos com risco de conflito;
6. delegar trabalhos independentes a subagentes;
7. manter para si decisões arquiteturais, integração entre módulos e alterações com forte acoplamento.

O principal **não deve delegar “implementar a fase inteira”**.

---

## 4. Modelo obrigatório de tarefa para subagente

Cada delegação deve conter:

```text
OBJETIVO
Uma única entrega concreta.

ESCOPO DE ARQUIVOS
Arquivos/pastas que pode ler e alterar.

NÃO ALTERAR
Áreas explicitamente fora da tarefa.

CONTEXTO MÍNIMO
Somente regras do domínio/técnicas necessárias.

CRITÉRIOS DE ACEITE
Resultados observáveis.

TESTES/VALIDAÇÃO
Comandos que devem passar.

RETORNO
Resumo curto, arquivos alterados, testes executados e riscos.
```

Exemplo:

```text
Objetivo: implementar Value Object Tombo e testes de unicidade/formato.
Escopo: src/modules/patrimony/domain/** e tests/unit/patrimony/**.
Não alterar: Prisma schema, API, UI.
Aceite: criação rejeita valor vazio; regras de domínio cobertas; testes verdes.
Validação: npm test -- patrimony.
Retorno: máximo 8 linhas + lista de arquivos.
```

---

## 5. Estratégia de subagentes

### Agente explorador

Preferencialmente read-only.

Tarefas:

- mapear arquivos relevantes;
- localizar padrões existentes;
- identificar dependências;
- comparar implementação com especificação.

Não implementa se a tarefa for apenas investigação.

### Agente de domínio/testes

Tarefas:

- escrever primeiro testes de invariantes (TDD);
- implementar Value Objects/Policies pequenos quando o escopo for isolado;
- retornar regras cobertas.

### Agente implementador

Tarefas curtas de código com arquivos exclusivos.

### Agente de query/reporting

Cuida de Query Handlers, projections e SQL de leitura em escopo não concorrente com escrita.

### Agente de infraestrutura

Docker, Coolify, VPS/Linux, CI/CD, scripts, Cloudflare R2, PostgreSQL operacional e observabilidade quando solicitados, sem alterar domínio.

### Agente revisor

Preferencialmente não modifica inicialmente. Revisa diff contra critérios, executa testes focados e reporta riscos.

---

## 6. Regra de paralelismo

Subagentes podem trabalhar em paralelo **somente em escopos de escrita disjuntos**.

Preferência:

```text
1 agente principal
+ até 2–3 subagentes independentes
```

Exemplos seguros:

```text
Agente A → domínio Catalog
Agente B → UI Entity list
Agente C → testes de Migration parser
```

Exemplo inseguro:

```text
Agente A → altera prisma/schema.prisma
Agente B → também altera prisma/schema.prisma
```

Nesse caso, serializar as tarefas ou deixar o arquivo compartilhado sob responsabilidade do agente principal.

---

## 7. Integração pelo agente principal

Após subagentes concluírem:

1. ler os resumos;
2. inspecionar os diffs reais;
3. rejeitar alterações fora do escopo;
4. resolver integração;
5. executar testes focados;
6. executar lint/typecheck;
7. quando o incremento estiver completo, executar suite relevante/build;
8. atualizar checklist da fase;
9. reportar o que ficou pronto e o próximo item.

O subagente que implementou uma mudança **não é a única fonte de validação**; usar outro agente revisor ou testes determinísticos para mudanças críticas.

---

## 8. TDD pragmático

Usar ciclo `RED → GREEN → REFACTOR` para:

- invariantes;
- Commands críticos;
- Policies;
- autorização;
- saldo/estoque;
- Tombos;
- migração;
- sincronização offline;
- concorrência/idempotência.

Para CRUD simples e UI estrutural, testes podem ser escritos junto/ao final quando TDD não trouxer benefício real.

---

## 9. Ordem dentro de cada feature

Para feature de domínio rica:

```text
1. Invariante / exemplos
2. Testes de domínio
3. Domain Model
4. Application Command/Query
5. Repository/Prisma adapter
6. Migration de schema
7. Route Handler REST
8. OpenAPI
9. UI mínima
10. Auditoria/Event/Outbox
11. Testes integração/E2E necessários
12. Docs/ADR se houve decisão nova
```

Não criar UI primeiro para depois tentar encaixar regras.

---

## 10. Política de migrations Prisma

- toda mudança de schema via migration versionada;
- nunca editar produção manualmente;
- uma tarefa deve alterar `schema.prisma` apenas quando necessário;
- agente principal coordena mudanças simultâneas no schema;
- migration de banco **não se confunde** com MigrationBatch de legado.

---

## 11. Política de Git para Codex

O usuário executa Git principalmente via CLI.

Por padrão, os agentes:

- podem inspecionar `git status`/`git diff`;
- **não criam branch, não fazem commit, não fazem push** sem pedido explícito;
- não descartam alterações pré-existentes do usuário;
- não usam `git reset --hard`, `clean -fd` ou operações destrutivas sem autorização explícita.

Workflow humano:

```text
feature/* → homolog → main
```

Branches `homolog` e `main` protegidas no remoto.

---

## 12. Qualidade por incremento

Antes de considerar um incremento concluído:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Quando houver integração PostgreSQL:

```powershell
npm run test:integration
```

Quando houver fluxo crítico web:

```powershell
npm run test:e2e
```

Os scripts exatos podem evoluir; `AGENTS.md` deve ser atualizado quando mudarem.

---

## 13. Definition of Done operacional

### Command crítico

- domínio e exemplos atendidos;
- autorização/escopo;
- transação;
- locking/idempotência quando aplicável;
- auditoria;
- eventos/outbox;
- testes unitários/integração;
- erro de domínio amigável;
- observabilidade mínima.

### Query

- escopo aplicado no backend;
- campos mínimos necessários;
- paginação/ordenação/filtros;
- índices adequados;
- sem N+1 relevante;
- testes;
- exportação usa a mesma especificação quando aplicável.

### UI

- estados loading/empty/error;
- acessibilidade básica;
- não contorna autorização do backend;
- uma aba operacional ativa quando a fundação UX estiver implantada.

---

## 14. Mudanças arquiteturais durante implementação

Se surgir necessidade que contradiga os specs:

```text
NÃO alterar silenciosamente.
```

O agente deve:

1. parar somente a decisão conflitante, não todo o trabalho independente;
2. registrar `OPEN-QUESTION` curto;
3. propor 1–2 alternativas;
4. se for possível seguir sem a decisão, continuar outras tarefas;
5. criar/atualizar ADR após decisão.

---

## 15. Estratégia para 50–200 mil registros legados

Implementar framework de importação separado dos importadores de negócio.

Cada lote:

```text
Upload
→ staging
→ validação completa
→ relatório de erros OU dry-run válido
→ confirmação
→ incorporação atômica do lote
```

Permitir fracionamento por ano/GRE/lote. Validar dependências já incorporadas.

Não carregar 200 mil Aggregates completos em memória. Processar staging/validação em lotes técnicos, mantendo atomicidade de negócio da incorporação escolhida.

Templates oficiais XLSX; CSV opcional para massa.

Arquivos auxiliares exportáveis usam códigos públicos estáveis de Material, Entidade, Contrato etc., nunca PK interna como contrato de integração.

---

## 16. Estratégia de infraestrutura e operação

A infraestrutura oficial usa três VPS:

```text
VPS 1 → Coolify + Traefik + Web/API + Worker + Scheduler
VPS 2 → PostgreSQL PRIMARY nativo
VPS 3 → PostgreSQL STANDBY + Grafana/Loki/Prometheus + contingência
R2    → documentos + backups externos
```

Regras de implementação:

- não instalar Nginx/Envoy apenas por hábito; Traefik é o proxy inicial;
- PostgreSQL PROD não roda no mesmo container/host da aplicação;
- PostgreSQL não deve ficar publicamente exposto; usar rede privada ou WireGuard;
- preparar streaming replication e runbook de promoção do standby;
- replicação não substitui backup; manter backup externo diário no R2;
- testar restauração periodicamente;
- Alloy coleta telemetria; Prometheus/Loki armazenam sinais; Grafana apresenta;
- manter observabilidade simples, sem HA própria;
- HML deve ensaiar deploy, restore e failover antes de PROD;
- scripts operacionais devem ser versionados em `ops/` ou diretório equivalente;
- alterações relevantes de infraestrutura exigem ADR.

### Subagentes de infraestrutura

O agente principal pode delegar tarefas independentes, por exemplo:

```text
Agente A → Docker/Coolify da aplicação
Agente B → configuração de observabilidade
Agente C → scripts/documentação de backup/restore
```

Não paralelizar alterações concorrentes no mesmo `docker-compose`, arquivo central de secrets, configuração Traefik ou runbook de failover.

---

## 17. Estratégia de rollout

O Monólito Modular não exige Big Bang.

- liberar capacidades por fase;
- usar feature flags simples apenas para exposição/rollout;
- nunca usar flags para desligar invariantes;
- homologar cada fase antes de produção;
- grandes migrações ocorrem após backup/snapshot operacional.

---

## 18. Resultado esperado do Codex a cada sessão

O agente principal deve sempre terminar com:

```text
STATUS
- tarefa concluída / parcial / bloqueada

ALTERAÇÕES
- arquivos principais

VALIDAÇÃO
- comandos executados e resultado

DECISÕES
- nenhuma, ou ADR/questão aberta

PRÓXIMA TAREFA
- uma tarefa curta e concreta
```

Evitar dumps extensos de logs; subagentes devem devolver somente erros e evidências úteis.
