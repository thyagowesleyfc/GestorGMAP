# Patrimony

Modulo do contexto `patrimony`, responsavel pelo nucleo de identidade patrimonial,
Tombos e movimentacoes patrimoniais.

Incremento inicial da Fase 6:

- `domain/tombo.ts`: Value Object `Tombo`, com normalizacao e validacao local de
  formato. O limite de tamanho e tecnico/local; unicidade global e nao reutilizacao
  pertencem a persistencia e Commands futuros.
- `patrimony` e `patrimony_tombo`: base persistente para identidade interna estavel,
  Tombo unico, Tombo ativo por patrimonio e historico que impede reutilizacao.

Ainda nao ha geracao de sequencia, incorporacao, retombamento, movimentacoes ou APIs neste
contexto.
