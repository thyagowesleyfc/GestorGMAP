# Patrimony

Modulo do contexto `patrimony`, responsavel pelo nucleo de identidade patrimonial,
Tombos e movimentacoes patrimoniais.

Incremento inicial da Fase 6:

- `domain/tombo.ts`: Value Object `Tombo`, com normalizacao e validacao local de
  formato. O limite de tamanho e tecnico/local; unicidade global e nao reutilizacao
  pertencem a persistencia e Commands futuros.
- `patrimony` e `patrimony_tombo`: base persistente para identidade interna estavel,
  Tombo unico, Tombo ativo por patrimonio e historico que impede reutilizacao.
- `application/allocate-tombo-sequence.ts` e
  `infrastructure/postgres-tombo-sequence-allocator.ts`: alocacao transacional do
  proximo Tombo no padrao `011-GRUPO-SEQUENCIA`, em que `011` e o COD fixo da
  SEDUC/GMAP e `GRUPO` e o grupo patrimonial numerico (`01`, `02`, `03`...).
- campos `source_delivery_id`, `source_shipment_item_id` e `incorporated_at` em
  `patrimony`: base para rastrear a Entrega e o item de Expedicao que originaram
  a incorporacao patrimonial.
- `application/incorporate-patrimony-from-delivery.ts` e
  `infrastructure/postgres-patrimony-incorporator.ts`: incorporacao atomica de
  Entregas `TOTAL` com Material Singular tombavel; `PARCIAL` e configuracoes
  permanecem explicitamente pendentes.

O alocador de sequencia garante unicidade e ordem sob concorrencia, mas nao e um Command
idempotente isolado. Commands de incorporacao e futuros Commands de retombamento devem chamar a alocacao
na mesma transacao idempotente do efeito patrimonial para evitar consumo repetido em retry.

Ainda nao ha retombamento, movimentacoes ou APIs neste contexto.
