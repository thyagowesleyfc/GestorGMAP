# ADR-011 - Alocação contratual e glosa por linha da OS

Status: Aceito

## Contexto

Uma Ordem de Serviço pode atender vários Patrimônios e conter vários
serviços. A regra de negócio exige que uma glosa parcial ou total preserve a
execução alegada e restitua somente o saldo contratual correspondente. Uma OS
ligada apenas ao Contrato, sem quantidade, preço e Item Contratual por linha,
não permite identificar com segurança qual saldo deve ser restituído.

## Decisão

Adotar alocação contratual por linha de serviço:

- cada linha referencia um Item Contratual do mesmo Contrato de Serviço;
- a linha congela descrição, quantidade, preço unitário e valor total na
  emissão;
- uma OS pode envolver vários serviços e vários Itens Contratuais, mas não
  pode cruzar Contratos;
- a emissão bloqueia as posições dos Itens Contratuais, valida todas as linhas
  e compromete quantidade e valor atomicamente;
- a glosa informa quantidade por linha e o valor é calculado pelo preço
  unitário congelado;
- depois da confirmação funcional da Entidade, Patrimônio pode atestar ou
  registrar a glosa;
- a quantidade e o valor glosados retornam do saldo comprometido para o saldo
  disponível e
  geram movimento próprio no ledger, referenciando OS e linha;
- glosa parcial e total são estados explícitos da OS, sem apagar execução ou
  ateste;
- cada OS possui uma única liquidação de glosa; correção posterior exige fluxo
  formal próprio;
- o Command de emissão/glosa é transacional, idempotente, auditável e publica
  Outbox quando o fato for efetivado.

O comprometimento da OS será distinto do comprometimento de OF no ledger de
saldo contratual. Não será usado ajuste genérico sem referência à origem.

## Consequências

- será necessária migration para vincular linhas da OS a Itens Contratuais,
  congelar seus valores e registrar os movimentos de comprometimento e
  restituição;
- testes deverão cobrir múltiplas linhas, múltiplos Itens Contratuais,
  concorrência, insuficiência, glosa parcial, glosa total, idempotência e
  rollback;
- a implementação não poderá restituir saldo de outra linha, OS ou Contrato;
- a correção de glosa efetivada exigirá fluxo formal, sem edição direta do
  ledger ou da posição de saldo.
