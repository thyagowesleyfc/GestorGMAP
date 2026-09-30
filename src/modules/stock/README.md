# Stock

Contexto de estoque do GESTOR GMAP.

Este modulo concentra o recorte funcional da Fase 4 para entrada e disponibilidade de estoque. Os commands atuais usam transacao PostgreSQL, idempotencia em `command_idempotency`, auditoria em `audit_entry` e locks pessimistas onde ha disputa de saldo.

Escopo implementado na Fase 4:

- entrada de estoque por recebimento/regularizacao com `StockMovement` append-only e `StockPosition`;
- reserva de estoque com lock de disponibilidade;
- separacao de estoque convertendo saldo reservado em saldo em separacao;
- devolucao de estoque retornando saldo em separacao para disponivel;
- testes de integracao com PostgreSQL real via Testcontainers.

Fora deste recorte:

- API/UI de estoque;
- eventos/outbox especificos de estoque;
- fluxos logisticos da Fase 5.
