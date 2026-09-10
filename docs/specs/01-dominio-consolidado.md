# GESTOR GMAP — Especificação Consolidada de Domínio
## DDD Estratégico e Tático — Revisão pós-Rodadas Técnicas 1–8

> Status: domínio validado após a investigação técnica. As decisões técnicas **não alteraram o modelo central do domínio**. Foram incorporadas apenas três precisões: (1) atomicidade da migração é por lote; (2) migrações podem ser fracionadas, respeitando dependências; (3) observações offline de Fiscalização preservam a versão de referência e nunca sobrescrevem fatos oficiais posteriores.

---

## 1. Visão do Produto

O **GESTOR GMAP** é o ERP interno da Gerência de Materiais e Patrimônio da SEDUC/PI.

Seu objetivo central é garantir **identidade, rastreabilidade, custódia, estado e controle do ciclo de vida dos recursos materiais da SEDUC**, desde a demanda até a baixa.

Fluxo principal:

```text
Solicitação
→ Autorização
→ Contrato/Origem
→ Recebimento
→ Regularização
→ Estoque
→ Reserva
→ Separação
→ Expedição
→ Entrega
→ Patrimonialização
→ Uso
→ Movimentações
→ Manutenção
→ Fiscalização
→ Recondicionamento ou Baixa
```

Princípio fundamental:

> **Fatos físicos e classificações administrativas são independentes.**

Um fato físico ocorrido nunca deve ser apagado ou reescrito para acomodar uma classificação administrativa posterior.

---

## 2. Core Domain

### Gestão Integrada do Ciclo de Vida de Materiais e Patrimônio

O Core Domain controla:

```text
o que é o recurso
onde está
de onde veio
para onde foi
quem é responsável
qual seu estado
qual sua composição
quais movimentos sofreu
quais manutenções sofreu
qual sua situação patrimonial atual
```

### Subdomínios centrais

- Solicitações;
- Recebimento;
- Estoque;
- Logística;
- Patrimônio;
- Manutenção;
- Fiscalização Patrimonial.

### Supporting Subdomains

- Catálogo;
- Entidades;
- Contratos;
- Reporting;
- Migração/Integrações.

### Generic Subdomains

- Organização/IAM;
- Notificações;
- Observabilidade técnica.

---

## 3. Bounded Contexts

```text
ORGANIZATION / IAM
CATALOG
ENTITIES
REQUESTS
CONTRACTS
RECEIVING
STOCK
LOGISTICS
PATRIMONY
MAINTENANCE
INSPECTION
REPORTING
INTEGRATIONS / MIGRATION
```

### Context Map resumido

```text
CATALOG ─────┬────→ REQUESTS
             ├────→ CONTRACTS ──→ RECEIVING ──→ STOCK
             └────→ PATRIMONY               └──→ LOGISTICS
                                                  ↓
                                              PATRIMONY
                                              ↙       ↘
                                      MAINTENANCE   INSPECTION

REPORTING
→ consome projeções dos contextos

INTEGRATIONS / MIGRATION
→ traduz fontes externas/legado e protege o domínio

ORGANIZATION / IAM
→ controla identidade, competência e escopo transversalmente
```

---

## 4. Linguagem Ubíqua Fundamental

### Material
Definição técnica e operacional de algo que pode ser adquirido, armazenado, movimentado, entregue ou patrimonializado.

### Bem
Instância física de um Material no ciclo de recebimento, estoque e logística.

### Patrimônio
Bem individualizado incorporado ao patrimônio institucional após aceite da Entrega.

### Tombo
Identificador patrimonial físico associado a Patrimônio tombável. **Tombo não é a identidade interna do Patrimônio.**

### Material Singular
Menor Material com significado independente, por exemplo Monitor, Gabinete, Microscópio, Mesa, Cadeira, Evaporadora.

### Composto
Estrutura formada por Singulares que continuam possuindo significado próprio, por exemplo Computador, Split e Conjunto Aluno.

### Kit
Configuração cujo significado depende principalmente da estrutura montada, por exemplo Kit Laboratório. Mudança estrutural relevante cria novo tipo/configuração; não há edição retroativa da configuração histórica.

### Classe
Classificação administrativa e política operacional padrão, como INFORMÁTICA, MOBILIÁRIO, REFRIGERAÇÃO, ESPORTIVO e LABORATÓRIO.

### Condição

```text
NOVO
REGULAR
RECONDICIONADO
INSERVÍVEL
```

### Estado operacional patrimonial

```text
EM_USO
RECOLHIDO
EM_MANUTENCAO
BAIXADO
```

Condição e estado são conceitos independentes.

---

## 5. CATALOG

Responsável pelo comportamento técnico e operacional dos Materiais.

Estrutura conceitual:

```text
Classe
  ↓
Material Singular
  ↓
Configuração de Kit/Composto
```

O Material Singular define, entre outros:

- nome e Classe;
- controle individual, quantitativo ou consumo;
- tombabilidade;
- grupo patrimonial;
- possibilidade de manutenção corretiva/preventiva;
- recondicionamento;
- substituição;
- serviços aplicáveis;
- estratégia operacional padrão.

Exemplos:

- **Microcomputador Tipo VI**: COMPOSTO de Monitor, Gabinete, Mouse e Teclado;
- **Split 12.000 BTUs**: COMPOSTO de Evaporadora e Condensadora;
- **Bola de Futsal**: SINGULAR quantitativo;
- **Kit Laboratório**: KIT com componentes tombáveis e quantitativos;
- **Conjunto Aluno Adulto**: COMPOSTO de Mesa e Cadeira.

Tombabilidade pertence ao Singular; Tombo pertence ao Patrimônio concreto.

---

## 6. ENTITIES

Entidades representam solicitantes, beneficiários, recebedores e responsáveis institucionais.

### Educacionais
- Escola;
- Anexo;
- Sala Escolar Avulsa.

### Administrativas
- Secretaria;
- Superintendência;
- Diretoria;
- Gerência;
- Coordenação;
- Unidade;
- Regional/GRE;
- Setor.

### Outras
- Prefeitura;
- Associação;
- instituição filantrópica.

A responsabilidade patrimonial pertence à **Entidade**, não ao signatário. A pessoa que assina Termo/Requisição permanece como evidência documental/auditoria.

A hierarquia atual é fonte para consolidações. Histórico anterior à entrada no GMAP não é reconstruído sem evidência confiável.

---

## 7. REQUESTS — Solicitação de Materiais

Aggregate principal: `SolicitacaoDeMateriais`.

Estados:

```text
TRIAGEM
NOVA
ANALISADA
DESPACHADA
FINALIZADA
```

Fluxo ordinário:

```text
Entidade
→ SEI / Redmine
→ Triagem registra
→ Gerência analisa e decide quantidades
→ Triagem despacha
→ Almoxarifado atende
→ Logística entrega
→ Patrimônio registra efeitos aplicáveis
→ Triagem finaliza
```

Determinação superior:

```text
Gerência cria
→ já nasce autorizada
```

SEI/Redmine são referências externas opcionais; uma Solicitação pode existir sem referência externa.

A Gerência autoriza quantidade por Material. Não escolhe unidades físicas específicas, Tombos ou lotes durante a autorização.

---

## 8. CONTRACTS

Aggregate principal: `Contrato`.

Mantém:

- fornecedor;
- vigência;
- objeto;
- itens;
- quantidades e preços;
- saldo;
- Gestor/Fiscais descritivos e temporais;
- Aditivos/Apostilamentos.

Aditivo/Apostilamento preserva histórico e pode afetar quantidade, valor, vigência, objeto, itens, preços e designações.

### Ordem de Fornecimento — OF

```text
Contrato
→ Item Contratual
→ OF
→ Entrada
```

A OF:

- compromete saldo contratual;
- não movimenta estoque físico;
- pertence a um Contrato;
- possui um ou mais itens;
- congela preço na emissão;
- é imutável após emissão;
- para alteração, cancela-se e emite-se outra.

Cancelamento:

```text
Contratos prepara
→ Gerência autoriza
→ Contratos efetiva
```

---

## 9. RECEIVING — Entrada e Regularização

Aggregate: `Entrada`, contendo `ItemEntrada`.

Princípio:

> **A Entrada primeiro registra o fato físico de que algo chegou.**

Um bem pode ser registrado mesmo com origem/OF ainda pendente. A regularização administrativa ocorre depois e é por item.

Uma Entrada pode conter itens:

```text
CONTRATUAL
INDENIZATÓRIO
PENDENTE
```

Fluxo ordinário de regularização:

```text
Almoxarifado registra
→ Líder valida
→ Gerência recebe ciência
```

Correções administrativas nunca reescrevem fatos físicos de recebimento.

---

## 10. STOCK

Saldo de estoque nunca é editado diretamente. É consequência de movimentos físicos válidos.

```text
Saldo
= Entradas
- Saídas
± Devoluções
± demais movimentos válidos
```

Conceitos:

```text
Estoque físico
Reservado
Em separação
Disponível
```

Também distinguir:

```text
Estoque total do Material
Estoque contratual
Estoque indenizatório
```

O estoque contratual pode ser analisado por Material, Contrato e Item Contratual.

### Reserva e Separação

A Gerência autoriza a demanda. O Almoxarifado reserva e separa. Separação bloqueia disponibilidade e nunca pode exceder saldo disponível.

---

## 11. LOGISTICS

Responsável por Expedição, Entrega, Recolha e retorno físico.

Uma Expedição/Envio possui uma única Entidade recebedora.

Aceite de Entrega:

```text
TOTAL
PARCIAL
RECUSADO
```

Kit/Composto não é aceito como estrutura completa quando sua configuração está quebrada.

### Recolha

```text
Entidade / Gerência origina necessidade
→ Patrimônio registra
→ Coordenação CALMOX autoriza operacionalmente
→ Almoxarifado + Logística executam
→ Gerência recebe ciência
```

Se a operação já estiver incluída em autorização gerencial anterior, não se exige autorização gerencial redundante.

---

## 12. PATRIMONY

Aggregate principal: `Patrimonio`.

A identidade interna é estável e independente do Tombo.

Mantém:

- Material;
- Entidade responsável;
- condição;
- estado operacional;
- composição;
- Tombos;
- origem;
- movimentos;
- manutenção;
- histórico.

### Patrimonialização

Ocorre após aceite da Entrega. O Bem passa a integrar o Inventário da Entidade.

### Tombos

- únicos;
- nunca reutilizados;
- associados a Patrimônio tombável;
- grupo patrimonial fixado conforme regra vigente na emissão.

Fluxo ordinário:

```text
Tombo gerado
→ etiqueta aplicada no Almoxarifado
→ saída já tombada
```

Contingência:

```text
Tombo virtual
→ Entrega
→ Fiscal da GRE aplica/confirma etiqueta depois
```

### Retificação x Retombamento

**Retificação**: cadastro está errado, identificação física está correta; corrige-se o cadastro, mantendo Tombo.

**Retombamento**: identificação física não pode ser reutilizada/reproduzida; Tombo antigo é encerrado por retombamento, novo Tombo é criado para o mesmo Patrimônio, com autorização, justificativa e auditoria.

Tombo antigo nunca é reutilizado.

---

## 13. Movimentações Patrimoniais e Baixa

Operações:

```text
Remanejamento
Empréstimo
Recolha
Baixa
```

Movimentação informal não é legitimada automaticamente. Quando fato irregular real for descoberto, preservam-se, quando conhecidas, `data_alegada_do_fato` e `data_da_regularizacao`; não se cria movimento retroativo fictício.

Motivos principais de Baixa:

```text
INSERVIBILIDADE
FURTO
PERDA
```

Patrimônio tombável inservível exige procedimento/laudo aplicável e autorização. Quantitativos podem ter baixa quantitativa sem laudo individual.

---

## 14. MAINTENANCE

Aggregate principal: `SolicitacaoDeManutencao`.

Estados:

```text
REGISTRADA
EM_ANALISE
ATENDIMENTO_EMITIDO
ATENDIDA
FINALIZADA
REJEITADA
CANCELADA
```

Fluxo:

```text
Entidade → SEI/Redmine → Triagem registra
→ Gerência autoriza
→ Patrimônio assume
```

Determinação superior pode ser criada pela Gerência já autorizada.

### Estratégia de atendimento

Precedência:

```text
Fluxo técnico obrigatório da Classe
→ Garantia específica do Patrimônio
→ Contrato de Serviço aplicável
→ Política do Material
→ Unidade interna responsável
```

Possibilidades: UTD, CERME, Contrato de Serviço, Garantia, avaliação para baixa ou rejeição.

Após emissão do atendimento, estratégia fica congelada; mudança exige cancelamento e novo atendimento.

### UTD / CERME

São atores externos sem usuário no GMAP inicialmente.

### Laudo

Conclusões:

```text
RECONDICIONÁVEL
IRRECUPERÁVEL
INDEFINIDO
```

Correções geram nova versão; não há sobrescrita histórica.

---

## 15. Ordem de Serviço — OS

A OS pertence operacionalmente ao contexto de Patrimônio/Manutenção.

Fluxo:

```text
Patrimônio prepara
→ Gerência autoriza
→ Patrimônio emite
→ prestador executa
→ Patrimônio acompanha
→ Entidade confirma funcionalmente
→ Patrimônio atesta ou solicita glosa
→ Contratos aplica efeitos contratuais
```

Uma OS:

- pertence a um Contrato;
- pertence a uma Entidade;
- pode ter vários Patrimônios e Serviços;
- é imutável após emissão.

Estados:

```text
EMITIDA
ENVIADA_AO_PRESTADOR
EXECUTADA
ATESTADA
CONCLUIDA_COM_GLOSA_PARCIAL
CONCLUIDA_COM_GLOSA_TOTAL
CANCELADA
```

Glosa pode ser parcial/total, preserva a execução alegada e restitui apenas o saldo correspondente.

Patrimônio irrecuperável não é automaticamente baixado.

### Peça técnica x Componente patrimonial

Peça técnica de manutenção não recebe identidade patrimonial. Componente patrimonial altera composição e, se tombável, recebe identidade/Tombo próprios.

### Garantia

Substituição integral encerra o Patrimônio antigo por substituição em garantia e cria novo Patrimônio com novos Tombos. Não há consumo artificial de Contrato de aquisição nem aumento líquido fictício.

---

## 16. INSPECTION — Fiscalização Patrimonial

**Inventário é Read Model/projeção. Fiscalização é processo transacional.**

Aggregates recomendados:

- `FiscalizacaoPatrimonial`;
- `ConferenciaDeInventarioDaEntidade`.

Estados:

```text
AGENDADA
EM_EXECUCAO
CONFERENCIA_CONCLUIDA
EM_REGULARIZACAO
ENCERRADA
CANCELADA
```

Resultados:

```text
LOCALIZADO_CONFORME
LOCALIZADO_NAO_CONFORME
LOCALIZADO_COM_DIVERGENCIA
NAO_LOCALIZADO
NAO_CONFERIDO
```

Fiscalização constata fatos observáveis, mas não altera estruturalmente Patrimônio, Entidade, Tombo, composição, incorporação ou Baixa.

Kit/Composto pode ser não conforme enquanto componentes específicos são tratados individualmente.

`NAO_LOCALIZADO` é resultado de conferência, não estado operacional patrimonial.

Divergências podem ser representadas por entidade simples sob a Conferência:

```text
ABERTA
EM_TRATAMENTO
REGULARIZADA
DESCARTADA
```

### Versão de referência e conectividade intermitente

A Conferência trabalha contra uma **versão de referência do Inventário**. As operações online do GMAP continuam normalmente durante a Fiscalização.

Quando a Fiscalização for executada temporariamente offline:

- registra-se o momento observado em campo separadamente do momento de sincronização;
- a observação offline é preservada como fato observado;
- movimento oficial posterior à versão de referência nunca é sobrescrito;
- se o estado oficial mudou desde a versão utilizada em campo, o resultado pode exigir reconciliação antes do encerramento;
- offline é contingência de curta duração e restrita a Fiscalização/Tombamento físico relacionado.

O modo offline não cria um segundo domínio nem um inventário permanente no dispositivo.

### Termo

Cada Entidade pode gerar Termo da Conferência, confirmado pelo Fiscal e responsável da Entidade, significando ciência do constatado, não concordância automática com responsabilidade ou Baixa.

---

## 17. ORGANIZATION / IAM

Cada Usuário representa exatamente uma Pessoa. Uma Pessoa possui no máximo um Usuário; não existem contas compartilhadas.

Times com acesso:

```text
GMAP
├── Gerência
├── Triagem
├── Contratos
├── Patrimônio
└── Fiscalização

CALMOX
├── Coordenação CALMOX
├── Almoxarifado
└── Logística

Superusuário
Fiscais de Patrimônio das GREs
```

Sem usuários inicialmente:

- responsáveis por Entidades;
- fornecedores/prestadores;
- UTD;
- CERME;
- Gestor/Fiscal legal de Contrato;
- órgãos externos.

### Membership

```text
Usuario
Time
Papel: MEMBRO | LIDER
Escopo: GLOBAL | GRE
Data início/fim
Ativo
```

Usuário pode participar de vários Times. Competências derivam do Time; não há permissões arbitrárias por usuário.

Gerência é exceção: seus membros ativos possuem a mesma autoridade gerencial; não há Líder interno da Gerência.

Superusuário é técnico e não recebe autoridade de negócio automaticamente.

### Três decisões distintas

1. **Autorização da Gerência**: gate de negócio.
2. **Validação do Líder**: gate interno quando previsto.
3. **Ciência da Gerência**: conhecimento/notificação, não bloqueia.

Permissão jamais supera invariante do domínio.

---

## 18. Auditoria e Histórico

Mutações de negócio preservam:

```text
quem
quando
o que aconteceu
antes/depois quando aplicável
motivo quando aplicável
```

Auditoria genérica responde principalmente **quem alterou e como**.

Histórico específico do domínio responde **o que aconteceu na vida do objeto** e é construído a partir de movimentos, Tombos, Entregas, Manutenções, Fiscalizações etc.

Fatos relevantes de negócio não são fisicamente apagados; correções usam retificação, cancelamento, versão ou evento corretivo conforme o conceito.

---

## 19. REPORTING

Quatro conceitos:

1. **Consulta** — leitura dinâmica com filtros, ordenação, paginação e drill-down.
2. **Relatório** — resultado estruturado/exportável.
3. **Extrato** — histórico cronológico de objeto específico.
4. **Dashboard** — indicadores consolidados que levam a consultas.

Read Models oficiais principais:

```text
PosicaoEstoque
SaldoContratual
InventarioEntidade
InventarioConsolidado
HistoricoPatrimonio
Visao360Entidade
IndicadoresSolicitacao
IndicadoresManutencao
IndicadoresFiscalizacao
DashboardGerencial
```

Read Model é projeção reconstruível, nunca segunda fonte de verdade.

### Visão 360° da Entidade

```text
Entidade
├── dados
├── solicitações
├── entregas
├── inventário
├── patrimônios
├── quantitativos
├── movimentações
├── manutenções
└── fiscalizações
```

Respeita escopo e competência. Ex.: Triagem pode ver histórico necessário à análise sem visualizar preço/saldo contratual.

### Métricas oficiais

Cada métrica formal deve definir nome, descrição, numerador, denominador, unidade, dimensões e fonte.

Não somar indiscriminadamente Kit/Composto com seus componentes, nem itens quantitativos com Patrimônios individualizados.

### Relatórios prioritários

1. Inventário Patrimonial;
2. Posição de Estoque;
3. Extrato de Movimentação de Estoque;
4. Relatório Analítico de Solicitações;
5. Extrato de Contrato;
6. Entradas e Regularizações;
7. Entregas;
8. Manutenção e OS;
9. Fiscalização Patrimonial;
10. Extrato Completo do Patrimônio.

Exportações: PDF, XLSX e CSV, respeitando escopo.

Power BI/Data Mart permanece futuro e não altera o Core Domain.

---

## 20. INTEGRATIONS — Fronteiras Externas

Matriz inicial:

| Fonte/ator | Estratégia |
|---|---|
| SEI | REFERENCIAR |
| Redmine | REFERENCIAR |
| E-mail | INTEGRAR AGORA |
| Base atual de Patrimônio | IMPORTAR |
| Inventários legados | IMPORTAR como fonte de posição/fatos |
| Base de Entidades/Escolas | MANUAL |
| UTD | NÃO SE APLICA como integração |
| CERME | NÃO SE APLICA como integração |
| Fornecedores | MANUAL |
| Responsáveis pelas Entidades | MANUAL/descritivo |
| Power BI | FUTURO |
| Outros sistemas SEDUC | NÃO SE APLICA inicialmente |

### Referência Externa

SEI e Redmine são objetos normalizados, não strings livres:

```text
ReferenciaExterna
sistema
tipo
identificador
URL opcional
```

Qualquer processo aplicável pode possuir `0..N` referências externas.

Status externo nunca controla estado interno do GMAP.

### E-mail

Falha de comunicação não reverte fato de negócio. Exemplo:

```text
EntregaConcluida
+
EmailFalhou
```

O envio pode ser reprocessado, mas Entrega permanece concluída.

---

## 21. Documentos

### Externo anexado

- tipo;
- origem;
- número;
- data;
- arquivo;
- usuário que anexou.

### Gerado pelo GMAP

- tipo;
- versão;
- data;
- autor;
- assinatura/confirmação.

Referência externa e Documento externo são conceitos diferentes.

Documentos versionáveis geram nova versão; documentos que já participaram de decisão não são silenciosamente apagados.

---

## 22. MIGRATION

Princípio central:

> **O legado informa o estado conhecido; ele não redefine o domínio novo.**

Somente Superusuário executa migrações.

Catálogo e Entidades são previamente cadastrados/curados no GMAP. Migração referencia registros válidos; não cria Material ou Entidade automaticamente.

Pode-se migrar:

### Estado administrativo inicial
- Contratos;
- Itens Contratuais.

### Fatos históricos confiáveis
- OFs;
- OSs;
- Entradas;
- Envios/Entregas;
- Patrimônios;
- Tombos;
- movimentações confiáveis.

Inventários legados servem como fonte para estabelecer/reconciliar posição, e não como um segundo Inventário concorrente.

### Importação atômica por lote

Cada `MigrationBatch` é independente:

```text
Upload do lote
→ valida todas as linhas
→ simula
→ 0 erros?
   ├── NÃO: incorpora nada do lote e retorna todos os erros
   └── SIM: Superusuário confirma e incorpora o lote inteiro
```

**Atomicidade é por lote**, não por toda a história legada. Lotes anteriores válidos não são desfeitos se um lote posterior falhar.

Migração pode ser fracionada por ano, GRE, tipo ou outro recorte operacional, desde que as dependências já existam.

Exemplo de dependência:

```text
Catálogo + Entidades
→ Contratos
→ OF / OS quando disponíveis
→ Entradas
→ Envios / Entregas
→ Patrimônios / Tombos / Composições
```

Duplicidade ou inconsistência faz o lote falhar; não existe saneamento permanente de legado dentro do domínio operacional.

### Registros contratuais legados

Para fatos legados contratuais:

```text
Contrato: obrigatório
Item Contratual: obrigatório
OF/OS: pode estar ausente quando historicamente indisponível
```

Essa exceção não se aplica às operações novas do GMAP.

### Patrimônio importado

Não existe tipo `PatrimonioLegado`. Após incorporação é Patrimônio normal, mantendo proveniência (`OrigemRegistro=LEGADO` e Migração).

Registro tombável sem Tombo ou estrutura incompatível com as invariantes atuais não é incorporado.

### Marco de Migração

Na ausência de história confiável:

```text
Posição patrimonial inicial importada do legado
```

não significa Entrega naquela data; significa que nessa data o GMAP assumiu o estado conhecido validado.

Quando há fatos históricos confiáveis, importam-se com suas datas reais. Nunca inferir ou inventar histórico.

### Posição atual

```text
Fatos legados válidos
+
Fatos nativos do GMAP
=
Posição atual
```

A mesma realidade não pode ser representada simultaneamente como fatos históricos completos e saldo inicial consolidado, evitando dupla contagem.

Importação de fatos históricos não dispara efeitos atuais, como e-mail de OS antiga.

---

## 23. Domain Events Conceituais

Exemplos relevantes:

### Solicitações
`SolicitacaoCriada`, `SolicitacaoAnalisada`, `SolicitacaoAutorizada`, `SolicitacaoRejeitada`, `SolicitacaoDespachada`, `SolicitacaoFinalizada`.

### Recebimento/Estoque
`EntradaRegistrada`, `ItemRegularizado`, `EstoqueReservado`, `ItemSeparado`, `ExpedicaoRegistrada`, `EntregaConfirmada`, `DevolucaoRegistrada`.

### Patrimônio
`PatrimonioIncorporado`, `TomboGerado`, `TombamentoFisicoConfirmado`, `PatrimonioRemanejado`, `PatrimonioEmprestado`, `PatrimonioRecolhido`, `PatrimonioBaixado`, `RetombamentoRealizado`, `ComponentePatrimonialSubstituido`.

### Manutenção
`SolicitacaoDeManutencaoRegistrada`, `EstrategiaDeAtendimentoDefinida`, `LaudoEmitido`, `OrdemDeServicoEmitida`, `ServicoAtestado`, `ExecucaoGlosadaParcialmente`, `ExecucaoGlosadaTotalmente`, `PatrimonioRecondicionado`, `PatrimonioSubstituidoEmGarantia`.

### Fiscalização
`FiscalizacaoAgendada`, `FiscalizacaoIniciada`, `ConferenciaDeEntidadeConcluida`, `PatrimonioLocalizadoConforme`, `PatrimonioLocalizadoNaoConforme`, `PatrimonioLocalizadoComDivergencia`, `PatrimonioNaoLocalizado`, `DivergenciaRegularizada`, `FiscalizacaoEncerrada`.

Integration Events futuros serão derivados dos eventos internos quando necessário.

---

## 24. Invariantes Gerais

1. Fato físico nunca é apagado para corrigir classificação administrativa.
2. Saldo de Estoque nunca é editado diretamente.
3. Tombo é único e nunca reutilizado.
4. Retombamento preserva histórico e identidade interna do Patrimônio.
5. Tombabilidade é definida pelo Singular.
6. Kit/Composto não muda história de composição retroativamente.
7. Separação não excede disponibilidade.
8. Responsabilidade patrimonial pertence à Entidade.
9. Movimentações exigem fluxo formal.
10. Operação contratual não excede saldo disponível.
11. OF e OS emitidas são imutáveis; correção exige fluxo formal.
12. Glosa restitui apenas saldo correspondente.
13. Patrimônio irrecuperável não é baixado automaticamente.
14. Substituição integral em garantia cria novo Patrimônio/Tombos.
15. Fiscalização constata; Patrimônio regulariza.
16. Fiscalização não desmonta/recompõe estruturas automaticamente.
17. Permissão nunca supera invariante.
18. Superusuário não recebe competência de negócio automaticamente.
19. Referência externa não controla estado interno.
20. Falha de comunicação não apaga fato ocorrido.
21. Migração inválida não produz alteração parcial no lote.
22. Legado não redefine regras do domínio novo.
23. Observação offline nunca sobrescreve movimento oficial posterior à versão de referência.

---

## 25. Decisões Arquiteturais Derivadas sem Alterar o Domínio

O domínio é compatível com:

- Monólito Modular;
- Domain Events internos;
- ledger/históricos específicos;
- Read Models;
- ACL/adapters para externos;
- operação offline seletiva de Fiscalização;
- Data Mart futuro.

Essas são formas de implementação e não passam a fazer parte da linguagem ubíqua, exceto quando refletem conceitos já existentes no negócio.

---

## 26. Pontos Abertos Não Bloqueantes

- detalhes finais de Planos Preventivos;
- SLA interno UTD/CERME;
- assinatura formal de alguns documentos;
- obrigatoriedade de fotos em cenários específicos;
- integração automática futura com SEI/Redmine;
- Power BI/Data Mart;
- granularidade futura por Ambiente;
- assinatura eletrônica dos Termos.

Nenhum desses pontos altera a estrutura estratégica atual.

---

## 27. Validação Pós-Investigação Técnica

A investigação técnica **não exigiu criação, remoção ou redefinição de Bounded Contexts, Aggregates centrais ou invariantes de negócio**.

Ajustes incorporados nesta revisão:

1. **Migração atômica por lote**, permitindo importações fracionadas e independentes;
2. **Dependências explícitas entre lotes migratórios**, sem transformar o GMAP em ferramenta de saneamento do legado;
3. **Fiscalização offline de curta duração**, preservando `observed_at`, sincronização posterior, versão de referência e reconciliação quando o estado oficial mudou.

Todo o restante permanece coerente com o consolidado pós-Rodada 11.
