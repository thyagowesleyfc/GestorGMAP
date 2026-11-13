# Casos de Uso de Manutenção

## Documento arquitetural permanente

Este documento detalha os casos de uso de Manutenção que aparecem na Fase 7 e
consolida as decisões necessárias para implementação segura.
Ele complementa, sem substituir, `01-dominio-consolidado.md`,
`02-especificacao-tecnica-consolidada.md`, `03-plano-implementacao.md` e
`04-fases-implementacao.md`.

O documento separa explicitamente:

- decisões já estabelecidas pelo domínio, que devem ser formalizadas na
  implementação;
- eventuais decisões ainda abertas, que não devem ser escolhidas pelo agente ou
  pelo implementador sem manifestação do responsável pelo domínio.

Nenhuma seção deste documento autoriza, por si só, a criação de código,
migration ou endpoint. A implementação só começa depois de fechadas as
decisões humanas que forem pré-condições do caso de uso.

## 1. Referências e regras transversais

As regras gerais de autorização, sessão, Membership, escopo, transação,
concorrência, auditoria, `correlation_id`, Transactional Outbox e idempotência
continuam sendo as definidas nas especificações consolidadas. Este documento
apenas as aplica aos casos de uso abaixo.

Para Commands críticos de Manutenção, a implementação posterior deve observar,
conforme aplicável:

1. autenticação por sessão server-side;
2. Usuário ativo e `TeamMembership` compatível;
3. papel `MEMBRO` ou `LIDER` apenas quando a política do caso exigir;
4. escopo `GLOBAL` ou `GRE` verificado no backend;
5. autorização da Gerência quando o fluxo de Solicitação exigir esse gate;
6. validação na Application/Domain Layer, além da proteção da borda HTTP;
7. PostgreSQL como fonte transacional;
8. uma transação para os fatos essenciais, auditoria e Outbox necessários;
9. lock pessimista para Patrimônio, composição ou saldo crítico concorrente;
10. idempotência por `CommandId`/`Idempotency-Key` quando houver risco de retry;
11. `correlation_id` em fato, auditoria, evento e logs;
12. erros de domínio diferenciados de erros técnicos.

O `actorUserId` deve vir da sessão autenticada. Não deve ser aceito como
identidade confiável no body de uma API. O `teamContext` também deve ser
derivado do caso de uso ou validado contra a competência do ator, nunca usado
para conceder competência por si só.

## 2. Substituição integral de Patrimônio em garantia

### 2.1 Decisões já existentes no domínio

Já está decidido que:

- a operação decorre do fluxo de Manutenção com estratégia de garantia;
- o Patrimônio antigo não é transformado no novo Patrimônio;
- o Patrimônio antigo encerra seu ciclo;
- o encerramento possui motivo equivalente a `SUBSTITUICAO_EM_GARANTIA`;
- um novo Patrimônio é criado pelo próprio Command, dentro da mesma transação,
  como unidade física substituta, com origem de incorporação decorrente de
  `SUBSTITUICAO_EM_GARANTIA`, e não como nova aquisição contratual ordinária;
- o novo Patrimônio recebe novos Tombos quando for tombável;
- Tombos antigos não migram para a unidade substituta;
- Tombo nunca é reutilizado;
- deve existir vínculo histórico navegável entre Patrimônio antigo e substituto;
- a navegação histórica deve funcionar do Patrimônio anterior para o substituto
  e do substituto para o Patrimônio anterior;
- a origem da nova unidade mantém referência explícita ao Patrimônio
  substituído, à Solicitação/fluxo de Manutenção, à ocorrência ou atendimento
  de garantia e aos documentos/evidências aplicáveis;
- a operação não consome artificialmente saldo de Contrato de aquisição;
- fatos históricos do Patrimônio antigo permanecem imutáveis;
- deve existir pelo menos uma evidência formal anexada ou uma referência
  externa formal. São aceitos Laudo, documento da assistência,
  comprovante/ordem do fornecedor, e-mail formal, Documento SEI ou equivalente;
- não há obrigatoriedade de um único tipo documental;
- a identidade interna do Patrimônio é independente do Tombo;
- permissão técnica não supera autorização ou invariante de negócio.

Essas decisões formalizam as regras de garantia e as invariantes de
Patrimônio já presentes nas especificações consolidadas.

### 2.2 Command conceitual

Nome conceitual:

```text
SubstituirPatrimonioEmGarantia
```

O nome final de classe, handler ou rota pode seguir a convenção do código, mas
deve preservar essa intenção semântica.

### 2.3 Intenção

Registrar, como fato único e rastreável, que um Patrimônio foi substituído
integralmente no contexto de uma Manutenção em garantia, encerrando a
continuidade operacional do anterior, criando a unidade substituta e mantendo
a relação histórica entre os dois.

O Command não corrige o Patrimônio antigo, não copia seu Tombo, não apaga sua
composição histórica e não simula uma compra ou um novo consumo do Contrato de
aquisição. O vínculo histórico resultante deve permitir navegação nos dois
sentidos.

### 2.4 Ator, competência e relação com a Manutenção

O contexto operacional é Patrimônio/Manutenção. A operação deve exigir sessão,
Usuário ativo, Membership e escopo compatíveis com o Patrimônio antigo e com a
Solicitação relacionada.

O executor é o Time PATRIMÔNIO, após a autorização da GERÊNCIA exigida pelo
fluxo de Manutenção. A operação não é automaticamente exclusiva do papel
`LIDER`; continuam obrigatórios sessão,
Usuário ativo, Membership, escopo e a validação da autorização no backend e nas
camadas de Application/Domain.

Deve existir pelo menos uma evidência formal anexada ou uma referência externa
formal. Laudo, documento da assistência, comprovante/ordem do fornecedor,
e-mail formal, Documento SEI ou equivalente são aceitos, sem preferência ou
obrigatoriedade de um único tipo documental.

### 2.5 Pré-condições

Pré-condições derivadas das decisões já existentes:

- o Patrimônio antigo existe;
- o Patrimônio antigo é tombável ou não tombável conforme sua própria regra de
  Material;
- existe uma Solicitação/fluxo de Manutenção relacionado;
- existe referência à ocorrência ou ao atendimento de garantia que originou a
  substituição;
- a Solicitação de Manutenção está autorizada pela GERÊNCIA conforme o fluxo
  existente, e a referência dessa autorização será vinculada ao fato;
- o alvo do Patrimônio está vinculado à Solicitação;
- a estratégia persistida para o alvo é `GARANTIA`;
- o Patrimônio antigo ainda não foi encerrado por essa substituição;
- o equipamento substituto ainda não foi incorporado por esta substituição;
- os fatos históricos anteriores estão íntegros;
- a operação possui chave de idempotência e `correlation_id`;
- existe pelo menos uma evidência formal anexada ou uma referência externa
  formal, sem exigir um tipo documental único.

### 2.6 Payload conceitual

Campos necessários ou candidatos:

| Campo | Situação | Finalidade |
|---|---|---|
| `patrimonio_antigo_id` | necessário | identifica a unidade que encerra o ciclo |
| `maintenance_request_id` | necessário | vincula a substituição ao atendimento |
| referência da autorização da GERÊNCIA | necessária | vincula a operação à autorização de negócio |
| referência da estratégia de garantia | necessária | comprova o enquadramento do caso |
| referência da ocorrência/atendimento de garantia | necessária | identifica o fato que originou a substituição |
| dados do equipamento substituto | necessário | descreve a unidade física que será criada pelo Command |
| Material/Configuração do substituto | necessário | determina identidade, tombabilidade e composição |
| número de série | condicional | identifica o equipamento quando o Material exigir |
| dados de composição | condicional | descreve Kit/Composto e componentes |
| justificativa | necessária | explica o fato e o encerramento |
| evidências/documentos | necessário | contém ao menos um anexo ou referência externa formal aplicável |
| `occurred_at` | necessário | data do fato de substituição |
| `correlation_id` | necessário | rastreabilidade transversal |
| `idempotency_key` | necessário | retry sem duplicação |

A origem de incorporação `SUBSTITUICAO_EM_GARANTIA`, os vínculos explícitos e a
criação do novo Patrimônio pelo próprio Command dentro da mesma transação são
decisões de negócio já fechadas. O payload deve fornecer os dados necessários
para criar a unidade física substituta; não deve aceitar um Patrimônio
previamente preparado que possa ficar órfão.

### 2.7 Transação conceitual

Depois de validar a autorização e as pré-condições, a operação deve ser
atômica. O fluxo conceitual é:

1. reservar a idempotência;
2. bloquear o Patrimônio antigo e as relações de composição/Tombo relevantes;
3. validar novamente a estratégia `GARANTIA`, a autorização e o estado atual;
4. validar a existência de pelo menos uma evidência formal anexada ou
   referência externa formal;
5. encerrar o Patrimônio antigo com motivo
   `SUBSTITUICAO_EM_GARANTIA`, sem apagar seus fatos;
6. encerrar os Tombos antigos quando aplicável, sem reutilizá-los;
7. criar o Patrimônio substituto, dentro desta transação, com origem
   `SUBSTITUICAO_EM_GARANTIA`;
8. criar novos Tombos quando a regra de tombabilidade exigir;
9. registrar a relação histórica antigo → substituto e os vínculos com a
   Solicitação/Manutenção, autorização, ocorrência de garantia e evidências,
   permitindo navegação nos dois sentidos;
10. registrar ou associar a nova composição, preservando as versões anteriores;
11. atualizar o fato de Manutenção que depende da substituição, se houver uma
    transição já definida;
12. gravar histórico específico, auditoria e Outbox;
13. armazenar o resultado da idempotência;
14. confirmar a transação.

Qualquer falha nos passos essenciais deve fazer rollback de todos os fatos da
substituição. Não pode haver Patrimônio novo sem vínculo histórico, encerramento
do anterior sem substituto quando a operação exigir substituto, Tombo novo sem
Patrimônio correspondente ou saldo de aquisição alterado artificialmente.

### 2.8 Persistência

O estado atual deve continuar em `Patrimony`, `PatrimonyTombo` e nas relações
atuais de composição. O histórico de composição não deve ser sobrescrito.

O vínculo antigo → substituto e a origem da nova unidade são fatos semânticos e
não devem depender somente de `AuditEntry`. A implementação provavelmente
precisará de uma persistência específica de substituição/origem, com pelo
menos:

- Patrimônio antigo;
- Patrimônio substituto;
- Solicitação/Manutenção relacionada;
- autorização da GERÊNCIA;
- ocorrência ou atendimento de garantia;
- origem `SUBSTITUICAO_EM_GARANTIA`;
- documentos/evidências aplicáveis;
- motivo;
- data do fato;
- executor do Time PATRIMÔNIO;
- justificativa/evidência;
- `correlation_id`.

A persistência deve manter pelo menos uma evidência formal anexada ou uma
referência externa formal. O modelo não deve exigir um tipo documental único.

O nome da tabela/modelo e a possibilidade de reutilizar algum histórico
existente dependem da inspeção final do modelo de Patrimônio e são decisões
técnicas de persistência. Não se deve criar tabela apenas para duplicar
auditoria.

O encerramento deve registrar explicitamente o motivo
`SUBSTITUICAO_EM_GARANTIA`, sem representar a operação artificialmente como
`BAIXA`. O estado operacional segue o ciclo patrimonial aplicável e permanece
separado do motivo de encerramento.

### 2.9 Estado operacional e motivo de encerramento

`estado operacional` responde “qual é a situação atual do Patrimônio?”.

`motivo de encerramento` responde “por que a continuidade daquele Patrimônio
terminou?”.

`SUBSTITUICAO_EM_GARANTIA` é tratado como motivo de encerramento e fato de
substituição, não como um estado operacional duradouro. Essa separação é uma
decisão de domínio já adotada neste documento.

O motivo não equivale a `EM_USO`, `RECOLHIDO`, `EM_MANUTENCAO` ou `BAIXADO`.
O Patrimônio novo começa com estado próprio, sem herdar automaticamente o
estado ou os Tombos do antigo.

### 2.10 Idempotência e concorrência

- A mesma chave e o mesmo payload devem retornar o resultado persistido sem
  criar outro Patrimônio, Tombo ou vínculo.
- A mesma chave com payload divergente deve retornar conflito.
- Retry após timeout deve recuperar o resultado committed, quando existente.
- Duas operações diferentes para o mesmo Patrimônio antigo devem ser
  serializadas por lock e somente uma pode encerrar o ciclo.
- A segunda operação deve retornar erro de domínio específico de substituição
  já realizada, sem efeitos parciais.
- Tentativas concorrentes de gerar Tombos devem respeitar a unicidade e o
  alocador oficial de Tombo.

### 2.11 Eventos e auditoria

O fato principal candidato é:

```text
PatrimonioSubstituidoEmGarantia
```

Ele deve carregar referências ao Patrimônio antigo, substituto, Manutenção,
autorização, evidências, motivo, data, executor e `correlation_id`. Deve ser
gravado na Outbox na mesma
transação se houver consumidor interno ou necessidade de projeção/notificação.

`PatrimonioIncorporado` somente deve ser produzido se a substituição realmente
executar uma incorporação que pertença a esse fluxo. Não emitir um segundo
evento apenas para repetir o mesmo fato. `PatrimonioEncerrado` só deve ser
separado se houver consumidor ou semântica distinta do evento de substituição.

A auditoria mínima deve preservar:

- ator e time/contexto;
- Patrimônio antigo e substituto;
- Solicitação/OS relacionada;
- autorização da GERÊNCIA;
- motivo;
- estado anterior e resultado;
- referência de evidência;
- data do fato;
- `correlation_id`.

### 2.12 Erros de domínio

O Command deve diferenciar, no mínimo:

- Patrimônio antigo inexistente;
- Solicitação inexistente ou não relacionada;
- autorização ausente;
- estratégia diferente de `GARANTIA`;
- reconhecimento/evidência obrigatória ausente;
- Patrimônio já encerrado;
- substituição já registrada;
- dados do substituto incompatíveis;
- Tombo obrigatório não gerado;
- conflito de idempotência;
- ator sem Membership/escopo;
- conflito de concorrência;
- falha técnica de persistência.

### 2.13 Testes necessários

- pré-condições e autorização;
- estratégia diferente de `GARANTIA`;
- preservação do Patrimônio antigo e de sua história;
- criação do substituto;
- Tombos novos e nunca reutilizados;
- vínculo histórico antigo → novo;
- ausência de consumo artificial do Contrato de aquisição;
- idempotência, replay e conflito de payload;
- concorrência no mesmo Patrimônio;
- rollback em cada falha essencial;
- auditoria e Outbox exatamente uma vez;
- integração PostgreSQL com constraints e locks.

### 2.14 API conceitual

Como a API atual organiza ações de OS sob
`/api/maintenance/service-orders/{serviceOrderId}`, uma ação de substituição
deve ser vinculada à Manutenção e ao Patrimônio, não tratada como CRUD livre.

Rotas candidatas, ainda não aprovadas:

```text
POST /api/maintenance/patrimonies/{patrimonyId}/warranty-replacement
POST /api/maintenance/service-orders/{serviceOrderId}/warranty-replacement
```

O contrato OpenAPI deve preservar o limite do Command, a criação transacional
do substituto e a referência a pelo menos uma evidência formal. A escolha do
caminho é uma decisão técnica de organização da API, não uma pendência de
domínio.

## 3. Substituição de componente patrimonial

### 3.1 Decisões já existentes no domínio

Já está decidido que:

- peça técnica de manutenção não recebe identidade patrimonial por si só;
- componente patrimonial altera a composição concreta do Patrimônio;
- a composição histórica não é apagada nem reescrita;
- o componente anterior não é simplesmente removido do passado;
- a composição atual passa a representar o substituto;
- componente tombável segue as regras de Patrimônio e Tombo;
- Tombo nunca é reutilizado;
- substituição é um fato formal, auditável e rastreável;
- Kit/Composto não recebe edição retroativa da configuração histórica;
- o Time PATRIMÔNIO executa a substituição;
- `MEMBRO` pode preparar e executar; `LIDER` não é gate obrigatório por padrão;
- Gerência autoriza quando houver alteração de identidade patrimonial, Tombo ou
  composição estrutural relevante;
- componente simples não tombável pode ser substituído sem nova autorização da
  Gerência quando a operação já estiver coberta pela Manutenção autorizada;
- toda substituição está vinculada a uma Manutenção;
- a origem do componente substituto é `MANUTENCAO`;
- o componente removido passa inicialmente à situação
  `REMOVIDO_EM_MANUTENCAO`, sem baixa automática;
- o destino posterior pode ser devolução ao fornecedor, recolhimento,
  baixa/descarte, recondicionamento ou reutilização, conforme o fluxo aplicável;
- Nota Fiscal não é obrigatória para origem `GARANTIA`, `UTD`, `CERME`,
  `ESTOQUE_TECNICO` ou equivalente formalmente registrado;
- componente tombável substituto é nova unidade física, com nova identidade e
  novo Tombo; o componente removido preserva sua identidade e histórico e nunca
  transfere seu Tombo;
- componente não tombável preserva histórico suficiente para reconstruir a
  alteração da composição;
- Kit/Composto recebe nova versão da composição concreta do Patrimônio.

### 3.2 Command conceitual e intenção

Nome conceitual:

```text
SubstituirComponentePatrimonial
```

O Command registra a troca de um componente concreto ou de uma posição de
componente na composição de um Patrimônio, criando uma nova versão da
composição atual e preservando a versão anterior.

Ele não deve ser usado para corrigir cadastro histórico, retificar um Tombo ou
trocar uma peça técnica sem identidade patrimonial. Esses fatos pertencem a
fluxos diferentes.

### 3.3 Distinção obrigatória de casos

| Caso | Efeito já definido | Tratamento implementável |
|---|---|---|
| Componente tombável | a nova unidade física possui nova identidade patrimonial e novo Tombo; o Tombo anterior não é reutilizado; o componente removido permanece com sua identidade e histórico e passa inicialmente a `REMOVIDO_EM_MANUTENCAO` | registrar o fato e encaminhar o destino posterior para fluxo próprio |
| Componente não individualizado/não tombável | não recebe Tombo individual; o histórico preserva Material, identificação disponível, componente anterior/substituto, datas, motivo, Manutenção e evidências aplicáveis | reconstruir a composição sem criar identidade patrimonial indevida |
| Componente de Kit | a configuração histórica não é reescrita; a substituição cria nova versão da composição concreta do Patrimônio | aplicar a nova versão sem alterar o tipo/configuração histórica |

Não se deve implementar os três casos com o mesmo efeito por conveniência.

### 3.4 Atores e pré-condições

O contexto operacional é Patrimônio/Manutenção, com sessão, Membership e
escopo do Patrimônio. A substituição deve estar vinculada a uma Manutenção.
Uma OS somente é obrigatória quando a estratégia ou modalidade de atendimento
aplicável exigir OS.

`MEMBRO` do Time PATRIMÔNIO pode preparar e executar. `LIDER` não é gate
obrigatório por padrão. A Gerência deve autorizar a operação quando houver
alteração de identidade patrimonial, Tombo ou composição estrutural relevante.
Componente simples não tombável pode ser substituído sem nova autorização da
Gerência quando a operação já estiver coberta pela Manutenção autorizada.

Pré-condições já compatíveis com o domínio:

- Patrimônio existe;
- Manutenção relacionada existe;
- composição vigente existe quando a operação for troca de composição;
- linha/componente indicado pertence à composição vigente;
- Material substituto é compatível com a Classe/configuração;
- não há operação concorrente que tenha criado nova revisão desde a leitura;
- fatos históricos anteriores estão preservados;
- a autorização da Gerência existe quando a operação alterar identidade,
  Tombo ou composição estrutural relevante.

A forma transacional de criação ou associação da nova unidade tombável é uma
decisão técnica, desde que preserve a nova identidade patrimonial, gere novo
Tombo e nunca reutilize o anterior.

A substituição pode ocorrer com o Patrimônio em `EM_USO` quando a Manutenção
for realizada in loco.

### 3.5 Payload conceitual

Campos candidatos:

- `patrimony_id`;
- referência da Manutenção;
- referência da OS, quando a estratégia/modalidade exigir OS;
- `componente_anterior_id` ou identificador da linha vigente;
- Material Singular substituto;
- origem do substituto, fixada em `MANUTENCAO`;
- Patrimônio substituto, se já existente;
- quantidade;
- número de série, quando aplicável;
- unidade/fornecedor, documento ou referência externa, quando disponíveis;
- data e evidências aplicáveis, quando disponíveis;
- justificativa e evidências;
- `occurred_at`;
- `correlation_id`;
- `idempotency_key`.

Nota Fiscal não é campo obrigatório para origem `GARANTIA`, `UTD`, `CERME`,
`ESTOQUE_TECNICO` ou equivalente formalmente registrado.

O payload deve refletir o tipo de componente, a origem fixa `MANUTENCAO`, a
Manutenção relacionada e a exigência condicional de OS. Não aceitar
simultaneamente campos mutuamente excludentes sem uma regra explícita.

### 3.6 Transação conceitual

1. reservar idempotência;
2. bloquear o Patrimônio, a composição vigente e o componente concreto quando
   houver;
3. validar versão, autorização condicional da Gerência, compatibilidade e
   pré-condições;
4. criar nova revisão da composição, mantendo a revisão anterior;
5. para componente tombável, criar a nova unidade patrimonial com identidade e
   Tombo novos, sem reutilizar o Tombo anterior;
6. preservar a referência ao componente anterior, sua identidade e seu Tombo
   quando tombável, e registrar a situação inicial
   `REMOVIDO_EM_MANUTENCAO`;
7. registrar a origem `MANUTENCAO`, unidade/fornecedor, documento ou referência,
   número de série, data e evidências quando disponíveis;
8. registrar o fato específico de substituição;
9. registrar auditoria e Outbox necessárias;
10. gravar resultado de idempotência;
11. commit.

Qualquer falha deve reverter a nova revisão, o vínculo do componente, o Tombo
novo e os fatos auxiliares. A revisão histórica anterior nunca deve ser
alterada para desfazer a operação. O destino posterior do componente removido
é tratado por fluxo próprio e não é decidido automaticamente por este Command.

### 3.7 Persistência, estado e histórico

As tabelas/modelos de composição versionada são candidatas a representar a
composição atual e histórica. A implementação deve confirmar se elas
conseguem, sem ambiguidade, registrar:

- linha anterior;
- linha substituta;
- componente Patrimônio anterior e novo;
- Material e identificação disponível quando o componente não for tombável;
- motivo e data;
- executor, referência da Manutenção e evidências aplicáveis.

Para componente tombável, o histórico deve preservar o Patrimônio anterior,
seu Tombo, o novo Patrimônio, o novo Tombo e a situação
`REMOVIDO_EM_MANUTENCAO`. O destino posterior deve ser um fato separado, como
devolução, recolhimento, baixa/descarte, recondicionamento ou reutilização.

Se não conseguirem, deve ser criado um registro específico de substituição de
componente. `AuditEntry` sozinho não substitui histórico semântico.

Estado operacional do Patrimônio e presença na composição são dimensões
distintas. Retirar um componente da composição não significa automaticamente
Baixa do componente nem do Patrimônio principal.

### 3.8 Idempotência, concorrência, eventos e erros

- mesma chave e mesmo payload: replay sem nova revisão, Tombo ou vínculo;
- mesma chave e payload diferente: conflito;
- duas substituições concorrentes na mesma linha: uma vence pelo lock/versão,
  a outra retorna conflito de versão ou componente já substituído;
- `ComponentePatrimonialSubstituido` é o evento conceitual principal;
- evento de incorporação ou encerramento só deve ser emitido quando for fato
  separado e houver consumidor;
- erros devem distinguir composição inexistente, linha ausente, incompatibilidade
  de Material, Tombo obrigatório, operação concorrente, autorização ausente e
  conflito de idempotência.

### 3.9 Testes e API conceitual

Testes necessários:

- revisão histórica preservada;
- substituição tombável com Tombo novo;
- tentativa de reutilizar Tombo;
- substituição não tombável sem criação indevida de Tombo;
- histórico completo da substituição não tombável;
- comportamento específico de Kit;
- nova versão concreta da composição de Kit/Composto;
- substituição in loco com Patrimônio `EM_USO`;
- autorização da Gerência somente quando a alteração for patrimonial ou
  estrutural relevante;
- substituição de componente simples coberta por Manutenção já autorizada;
- situação inicial `REMOVIDO_EM_MANUTENCAO` sem baixa automática;
- origem `MANUTENCAO` e ausência de exigência artificial de Nota Fiscal;
- autorização e escopo;
- idempotência e concorrência;
- rollback;
- auditoria, Outbox e integração PostgreSQL.

Rotas candidatas, ainda não aprovadas:

```text
POST /api/maintenance/patrimonies/{patrimonyId}/components/{componentId}/replacement
POST /api/maintenance/patrimonies/{patrimonyId}/component-replacement
```

A rota deve refletir se a unidade é uma linha de composição ou um componente
Patrimônio identificado. Essa escolha é técnica e deve acompanhar o payload
final do Command.

## 4. Plano de Manutenção Preventiva

### 4.1 Decisões já existentes

Está definido que:

- o plano inicialmente é manual;
- a existência de possibilidade de manutenção preventiva no Material não é,
  sozinha, autorização para executar uma OS;
- preventiva não gera automaticamente uma OS; a emissão depende da análise do
  Time PATRIMÔNIO e da aprovação da Gerência;
- a operação pode ser trabalhada em lote pela interface;
- uma OS pertence a uma única Entidade;
- a OS preventiva exige aprovação da Gerência antes da emissão, inclusive
  quando a interface permitir operação em lote;
- UTD/CERME não precisam de cadastro ou integração próprios na fase inicial.

O catálogo já possui a capacidade de indicar se um Material permite manutenção
preventiva, mas isso não define sozinho um Plano Preventivo.

### 4.2 Modelo conceitual mínimo

Para suportar a implementação, o Plano Preventivo possui dois eixos
explicitamente tipados e controlados.

#### Escopo territorial/institucional

O plano possui exatamente um modo territorial:

```text
TODAS
GRE
MUNICIPIO
ENTIDADES_ESPECIFICAS
```

`ENTIDADES_ESPECIFICAS` pode conter uma ou várias Entidades. Os identificadores
selecionados devem ser persistidos como parte do escopo tipado; não substituir
esse eixo por filtros livres ou uma linguagem genérica de regras.

#### Escopo patrimonial

O plano possui exatamente um modo patrimonial:

```text
TODOS
CLASSE
MATERIAL
PATRIMONIOS_ESPECIFICOS
```

Os modos `CLASSE`, `MATERIAL` e `PATRIMONIOS_ESPECIFICOS` mantêm as referências
correspondentes. A combinação dos dois eixos permite, por exemplo, todos os
aparelhos de uma Classe em uma GRE, um Material em um Município, uma Classe em
Entidades específicas ou Patrimônios específicos.

O plano possui `inicio_em` e `fim_em` opcional. Sem `fim_em`, permanece vigente
até suspensão ou cancelamento.

A periodicidade é composta por valor inteiro positivo e unidade:

```text
DIAS
MESES
ANOS
```

Exemplos: 90 dias, 6 meses ou 1 ano. Cron expression não é conceito de
domínio; o scheduler técnico pode usar qualquer mecanismo interno compatível.

Antes da ativação, o sistema deve verificar se existe outro Plano ativo cuja
interseção territorial/institucional e patrimonial alcance os mesmos
Patrimônios no mesmo período. Sobreposição conflitante impede a ativação,
informa o Plano conflitante e exige correção do escopo ou suspensão/cancelamento
do conflito. Não existe prioridade automática entre Planos.

Quando um novo Patrimônio passar a satisfazer o escopo de um Plano ativo, ele
entra automaticamente no universo elegível dos ciclos futuros. Essa inclusão
não depende de Fiscalização, Inventário, PWA offline ou sincronização da
Fiscalização.

`EM_USO` é normalmente elegível. `ENCERRADO` e `BAIXADO` não são elegíveis.
`EM_MANUTENCAO` e `RECOLHIDO` não descartam a ocorrência: ela deve ser adiada
ou reavaliada, preservando o histórico.

### 4.3 Commands e fluxo preventivo

O Time PATRIMÔNIO cria, edita, suspende e cancela o Plano. A ativação exige
autorização da Gerência. Os Commands conceituais são:

- `CriarPlanoPreventivo`;
- `AlterarPlanoPreventivo`;
- `AtivarPlanoPreventivo`;
- `SuspenderPlanoPreventivo`;
- `CancelarPlanoPreventivo`;
- `GerarOcorrenciaPreventiva`;
- `ReagendarOcorrenciaPreventiva`.

Uma ocorrência preventiva segue o fluxo:

```text
Plano Preventivo
→ Ocorrência/Previsão Preventiva
→ análise do Time PATRIMÔNIO
→ aprovação da Gerência
→ Solicitação/OS quando aplicável
```

O Plano nunca gera OS automaticamente. A ocorrência deve ser agrupada por
Entidade e por ciclo e pode conter vários Patrimônios da mesma Entidade,
preservando `1 OS = 1 Entidade`. A OS preventiva exige aprovação da Gerência
antes da emissão, inclusive em operação em lote.

Novos Patrimônios elegíveis entram automaticamente apenas nos ciclos futuros;
essa entrada não reescreve ciclos já registrados.

Reagendamento preserva data original, nova data, motivo obrigatório, autor,
timestamps e histórico. Um reagendamento novo não sobrescreve o anterior.

Ocorrências canceladas ou rejeitadas permanecem registradas. A geração e a
execução preventiva usam `CommandId`/`Idempotency-Key` e proteção contra
duplicação da mesma ocorrência lógica.

### 4.4 Testes necessários

- escopo e autorização de criação/alteração;
- seleção de alvos por cada modalidade de plano;
- vigência e periodicidade;
- inclusão posterior de Patrimônio;
- suspensão, cancelamento e reagendamento;
- exclusão de Patrimônio encerrado;
- conflito com outra Manutenção;
- decisão manual de geração de Solicitação;
- agrupamento sem cruzar Entidades;
- histórico preservado de ocorrências canceladas e rejeitadas;
- idempotência, concorrência e histórico;
- escopo territorial/institucional e patrimonial tipado;
- bloqueio de sobreposição conflitante na ativação;
- inclusão automática de Patrimônio em ciclos futuros;
- adiamento/reavaliação para `EM_MANUTENCAO` e `RECOLHIDO`;
- preservação integral de reagendamentos.

## 5. SLA de atendimento interno UTD/CERME

### 5.1 Decisões consolidadas

Está definido que:

- UTD e CERME são inicialmente unidades/atores externos ao GMAP;
- não haverá cadastro de Usuário UTD/CERME obrigatório na fase inicial;
- não haverá integração automática obrigatória;
- a estratégia de Manutenção pode direcionar o atendimento para UTD ou CERME;
- o GMAP pode acompanhar o atendimento sem transformar a unidade externa em
  um contexto IAM completo.

O GMAP não é dono da política operacional de UTD ou CERME. `SlaPolicy`
representa uma política/prazo definido institucionalmente ou externamente e
cadastrado no GMAP para acompanhamento; não é uma política criada
arbitrariamente pelo sistema.

### 5.2 Modelo conceitual e regras de acompanhamento

Antes de escolher prazos, o modelo precisa distinguir:

- política de SLA aplicável;
- obrigação/relógio de atendimento;
- o acompanhamento `SLA_ATENDIMENTO`, medindo encaminhamento até conclusão;
- períodos de pausa e retomada;
- vencimento calculado;
- ocorrência de atraso e justificativa;
- reagendamento e seu responsável;
- evidência manual do avanço externo.

O SLA é associado ao atendimento/encaminhamento da Manutenção para a unidade
UTD ou CERME correspondente. Não é associado diretamente ao Patrimônio.
Uma `SlaPolicy` pode considerar unidade e prioridade. Valores concretos não são
hardcoded.

Quando existe prazo formal cadastrado, o GMAP calcula o vencimento a partir do
encaminhamento, aplica as pausas válidas e registra conclusão ou atraso. Sem
prazo formal, acompanha tempo decorrido e produz métricas, mas não inventa
vencimento nem classifica artificialmente o atendimento como atrasado.

Políticas de SLA são versionadas; alterações posteriores não reescrevem o
vencimento histórico, as métricas históricas ou a interpretação de atendimentos
anteriores.

Na primeira versão não existem relógios separados para aceite, início ou
execução. O relógio único é `SLA_ATENDIMENTO`.

Quando houver política de prazo, consideram-se inicialmente dias úteis de
segunda a sexta-feira. Calendário sofisticado de feriados fica fora da primeira
versão, sem impedir evolução futura do modelo histórico.

As pausas formais iniciais são:

```text
AGUARDANDO_ENTIDADE
AGUARDANDO_PECA
AGUARDANDO_FORNECEDOR
```

Cada pausa registra motivo, `iniciado_em`, `iniciado_por`, `finalizado_em` e
`finalizado_por`. Como UTD/CERME não são usuários integrados inicialmente, o
Time PATRIMÔNIO registra pausa e retomada no GMAP.

Vencimento não altera automaticamente o estado da Manutenção. Produz indicador
de atraso, alerta e notificação.

Se o atendimento mudar de unidade ou estratégia, o SLA anterior é encerrado
com motivo registrado e um novo encaminhamento cria novo acompanhamento/SLA.
O histórico anterior não é apagado nem reescrito.

UTD e CERME possuem configuração interna controlada de cobertura/competência:

```text
UnidadeAtendimento: UTD | CERME
Cobertura: Classes atendidas e Materiais específicos atendidos, quando necessário
```

A sugestão de estratégia deve respeitar essa cobertura. Material ou Classe não
atendido pela UTD, por exemplo, não pode receber sugestão UTD válida. Isso não
é integração externa; é configuração interna da capacidade conhecida.

O SLA deve ser uma camada de acompanhamento. Ele não deve alterar sozinho o
estado de uma Solicitação ou OS sem um Command de negócio explícito.

### 5.3 Commands e fluxo de acompanhamento

Os Commands/casos de uso conceituais são:

- `RegistrarEncaminhamentoAtendimento`;
- `PausarSlaAtendimento`;
- `RetomarSlaAtendimento`;
- `RegistrarConclusaoAtendimento`;
- `MudarEstrategiaAtendimento`, que encerra o acompanhamento anterior com
  motivo e cria novo acompanhamento para a unidade/estratégia substituta.

O registro de encaminhamento deve validar a cobertura interna da unidade,
associar a `SlaPolicy` vigente quando existir e criar o acompanhamento
`SLA_ATENDIMENTO`. A conclusão fecha o acompanhamento e preserva o resultado.

### 5.4 Testes necessários

- aplicação correta da política;
- cálculo de prazo com calendário definido;
- pausas e retomadas;
- atraso e justificativa;
- reagendamento versionado;
- ausência de integração externa;
- idempotência de registros manuais;
- concorrência em atualização do relógio;
- projeções e métricas sem alterar o fato transacional;
- acompanhamento sem prazo formal sem vencimento artificial;
- versionamento de `SlaPolicy` sem alterar histórico;
- cobertura de UTD/CERME por Classe e Material;
- mudança de unidade/estratégia com encerramento e novo acompanhamento;
- `SLA_ATENDIMENTO` sem relógios independentes de aceite/início/execução.

## 6. Relação conceitual com a API

A API atual de Manutenção usa Route Handlers REST sob `/api/maintenance` e
ações de OS sob `/service-orders/{serviceOrderId}`. Os novos casos devem seguir
essa organização, mas os caminhos abaixo são somente candidatos:

```text
POST /api/maintenance/patrimonies/{patrimonyId}/warranty-replacement
POST /api/maintenance/patrimonies/{patrimonyId}/component-replacement
POST /api/maintenance/preventive-plans
POST /api/maintenance/preventive-plans/{planId}/occurrences/{occurrenceId}/request
```

O SLA pode ser exposto como atualização manual de acompanhamento ou como parte
de uma tela de Manutenção; nenhuma rota é aprovada neste documento.

Os contratos REST devem respeitar os limites dos Commands, os recursos
principais, o formato de evidências/documentos, `Idempotency-Key`,
`correlation_id`, os erros de domínio e o contrato OpenAPI. A escolha final de
rotas e DTOs é decisão técnica derivada desta especificação.

## 7. Impacto previsto na implementação atual

Esta seção não autoriza alterações. Ela antecipa o impacto para uma fase
posterior.

### Commands e Application

Commands/casos de uso necessários:

- `SubstituirPatrimonioEmGarantia`;
- `SubstituirComponentePatrimonial`;
- `CriarPlanoPreventivo`;
- `AlterarPlanoPreventivo`;
- `AtivarPlanoPreventivo`;
- `SuspenderPlanoPreventivo`;
- `CancelarPlanoPreventivo`;
- `GerarOcorrenciaPreventiva`;
- `ReagendarOcorrenciaPreventiva`;
- `RegistrarEncaminhamentoAtendimento`;
- `PausarSlaAtendimento`;
- `RetomarSlaAtendimento`;
- `RegistrarConclusaoAtendimento`;
- `MudarEstrategiaAtendimento`.

A aprovação da Gerência para ativação do Plano e emissão da OS preventiva deve
reutilizar o gate/Command de autorização do fato correspondente quando ele já
existir. Não criar Commands ou eventos duplicados apenas para mudar o nome da
operação.

### Aggregates e domínio

Prováveis áreas afetadas:

- `Patrimonio` e seu ciclo de encerramento;
- composição versionada de Patrimônio;
- vínculo semântico entre Patrimônio antigo e substituto;
- relação entre Manutenção, alvo e garantia;
- agregado de Plano Preventivo com os dois eixos de escopo;
- ocorrência/previsão preventiva e seus ciclos;
- acompanhamento `SLA_ATENDIMENTO`, pausas, políticas versionadas e cobertura
  interna de UTD/CERME.

### Persistência e migrations

Provavelmente serão necessárias alterações para:

- registrar substituição integral e vínculo antigo → novo;
- registrar motivo de encerramento sem confundi-lo automaticamente com Baixa;
- registrar substituição de componente quando a composição atual não suportar
  todos os fatos necessários;
- armazenar plano, os dois eixos de escopo, vigência, ocorrência e histórico
  preventivo;
- armazenar política versionada, marcos, pausas, encaminhamentos,
  justificativas e cobertura de UTD/CERME.

As migrations devem ser desenhadas somente após o fechamento das decisões de
modelo e cardinalidade.

### API, eventos e testes

Serão necessários, conforme o desenho técnico:

- handlers REST e contratos OpenAPI;
- adapters PostgreSQL transacionais;
- auditoria e Outbox dos fatos de negócio;
- testes unitários, autorização, idempotência, concorrência, rollback e
  integração PostgreSQL;
- E2E somente para fluxos críticos escolhidos.

Não há Read Model obrigatório novo antes de existir uma necessidade de leitura
com escopo, campos e métrica definidos.

## 8. Matriz de maturidade da especificação

| Item | Antes | Depois | Implementável? | Pendência humana? |
|---|---|---|---|---|
| Substituição integral em garantia | Regra conceitual de criar novo Patrimônio/Tombo e preservar o antigo | Command, evidência formal, origem, autorização, executor, vínculos bidirecionais, criação transacional, invariantes, estado/motivo, idempotência, concorrência, eventos, erros e testes foram estruturados | Sim | Não |
| Substituição de componente | Distinção geral entre peça técnica e componente patrimonial | Manutenção obrigatória, OS condicional, competência, autorização condicional, situação removida, destinos posteriores, origem, casos tombável/não tombável/Kit, revisão histórica e transação foram formalizados | Sim | Não |
| Plano Preventivo | Manual, sem OS automática; escopo e ciclos abertos | Dois eixos tipados, bloqueio de sobreposição, periodicidade, vigência, elegibilidade, geração manual, agrupamento, aprovação, reagendamento, histórico e idempotência foram formalizados | Sim | Não |
| SLA UTD | Unidade externa, sem integração obrigatória; SLA aberto | `SLA_ATENDIMENTO`, política cadastrada/versionada, cobertura, dias úteis iniciais, pausas, vencimento, alertas, mudança de unidade e histórico foram formalizados | Sim | Não |
| SLA CERME | Unidade externa, sem integração obrigatória; SLA aberto | Mesmo modelo de acompanhamento, com cobertura interna e histórico sem integração externa | Sim | Não |

## 9. Estado das decisões de domínio

Não há decisão de negócio pendente identificada para os casos de uso
detalhados neste documento. Os itens restantes são trabalho técnico de
modelagem, persistência, locking, idempotência, Outbox, API, migrations,
estrutura TypeScript e testes, a serem resolvidos durante a implementação sem
reabrir as decisões de domínio consolidadas.
