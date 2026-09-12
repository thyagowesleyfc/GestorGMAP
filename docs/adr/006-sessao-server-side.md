# ADR-006 - Sessao server-side

Status: Aceito

## Contexto

A Fase 1 exige autenticacao propria, revogacao de sessoes, visualizacao de sessoes ativas e cookies seguros. Sessao precisa ser controlavel no backend.

## Decisao

Usar sessao server-side persistida em PostgreSQL, com cookie HttpOnly, Secure e SameSite em producao.

## Consequencias

- Sessao pode ser revogada no backend.
- Reset de senha pode revogar sessoes existentes.
- Multiplas sessoes por usuario sao permitidas e administraveis.
- JWT stateless nao sera a estrategia inicial para sessao principal.
