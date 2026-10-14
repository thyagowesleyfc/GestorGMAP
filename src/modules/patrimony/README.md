# Patrimony

Modulo do contexto `patrimony`, responsavel pelo nucleo de identidade patrimonial,
Tombos e movimentacoes patrimoniais.

Incremento inicial da Fase 6:

- `domain/tombo.ts`: Value Object `Tombo`, com normalizacao e validacao local de
  formato. O limite de tamanho e tecnico/local; unicidade global e nao reutilizacao
  pertencem a persistencia e Commands futuros.

Ainda nao ha persistencia, geracao de sequencia, incorporacao, retombamento ou APIs neste
contexto.
