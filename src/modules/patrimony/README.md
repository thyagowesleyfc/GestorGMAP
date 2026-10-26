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
  permanecem explicitamente pendentes de incorporacao.
- `patrimony_composition` e `patrimony_composition_item`: fundacao versionada
  para snapshots de configuracoes e componentes.
- `application/register-patrimony-composition.ts` e
  `infrastructure/postgres-patrimony-composition-registerer.ts`: Command atomico
  para registrar nova revisao de composicao concreta, com autorizacao por
  Membership, idempotencia, snapshots, auditoria e Outbox. Componentes tombaveis
  precisam apontar para Patrimonio proprio com Tombo ativo; componentes nao
  tombaveis permanecem quantitativos e nao geram Tombo por inferencia.
- `application/get-patrimony-composition-history.ts` e
  `infrastructure/postgres-patrimony-composition-history-reader.ts`: Query
  paginada do historico de composicao, com escopo por Membership, campos minimos
  e carregamento dos itens em lote sem N+1.
- `application/retombar-patrimony.ts` e
  `infrastructure/postgres-patrimony-retomber.ts`: retombamento atomico do mesmo
  Patrimonio, encerrando o Tombo anterior, alocando novo Tombo na sequencia do
  mesmo grupo e mantendo auditoria, Outbox e idempotencia.
- `application/retificar-patrimony.ts` e
  `infrastructure/postgres-patrimony-retifier.ts`: retificacao do Material
  Singular do mesmo Patrimonio, sem alterar Entidade, Tombo ou snapshots, com
  validacao de compatibilidade, auditoria, Outbox e idempotencia.
- `application/remanejar-patrimony.ts` e
  `infrastructure/postgres-patrimony-remanejador.ts`: remanejamento atomico
  entre Entidades, preservando Patrimonio/Tombo e registrando ledger de
  movimento, auditoria, Outbox e idempotencia. Patrimonios envolvidos em
  composicao concreta permanecem bloqueados neste incremento.
- `application/emprestar-patrimony.ts` e
  `infrastructure/postgres-patrimony-emprestador.ts`: registro atomico de
  Emprestimo entre Entidades. Neste recorte, a Entidade destino assume a
  responsabilidade operacional, sem alterar Patrimonio/Tombo; o movimento
  tipado, auditoria, Outbox e idempotencia sao registrados. A devolucao do
  Emprestimo permanece fora deste recorte.
- A criacao de Patrimonios a partir de Kits/Entregas `PARCIAL`, Recolha, Baixa
  e APIs de composicao continuam pendentes.

O alocador de sequencia garante unicidade e ordem sob concorrencia, mas nao e um Command
idempotente isolado. Commands de incorporacao e futuros Commands de retombamento devem chamar a alocacao
na mesma transacao idempotente do efeito patrimonial para evitar consumo repetido em retry.

Ainda nao ha APIs neste contexto. Os movimentos implementados nesta etapa sao
Remanejamento e Emprestimo de Patrimonio sem composicao concreta.
