# ADR-001 - Monolito Modular

Status: Aceito

## Contexto

O GMAP tem alta complexidade de dominio, mas escala computacional inicial moderada. As specs priorizam consistencia, historico e rastreabilidade, sem custo operacional de microservicos no inicio.

## Decisao

Implementar o sistema como Monolito Modular em TypeScript/Node.js/Next.js, com modulos de dominio separados conceitualmente em `domain`, `application`, `infrastructure` e `api/adapters` quando houver complexidade real.

API, Worker e Scheduler podem rodar como processos diferentes da mesma base de codigo/release.

## Consequencias

- Modulos possuem fronteiras logicas e nao alteram diretamente dados proprietarios de outros modulos.
- Comunicacao entre modulos de escrita passa por Commands/Application Services/API interna.
- Reporting pode ler transversalmente, mas nao corrige estado.
- Microservicos exigem necessidade concreta e novo ADR.
