# ADR-002 - PostgreSQL

Status: Aceito

## Contexto

O GMAP exige consistencia transacional, historico, auditoria, concorrencia e consultas relacionais. As specs definem PostgreSQL como fonte transacional oficial.

## Decisao

Usar PostgreSQL como banco oficial para DEV, HML e PROD.

- DEV usa PostgreSQL em Docker local.
- HML usa PostgreSQL isolado de homologacao.
- PROD usa PostgreSQL nativo na VPS 2, com standby na VPS 3.

## Consequencias

- Testes de persistencia usam PostgreSQL real, nao SQLite.
- Constraints, transacoes e locks do banco protegem invariantes estruturais.
- Read Models iniciais tambem vivem no PostgreSQL e sao reconstruiveis.
- Banco por Bounded Context nao sera adotado inicialmente.
