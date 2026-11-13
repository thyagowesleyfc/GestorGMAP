# Casos de Uso de Manutenção

## Documento arquitetural permanente

Este documento detalha os casos de uso de Manutenção que aparecem na Fase 7,
mas ainda não possuem especificação suficiente para implementação segura.
Ele complementa, sem substituir, `01-dominio-consolidado.md`,
`02-especificacao-tecnica-consolidada.md`, `03-plano-implementacao.md` e
`04-fases-implementacao.md`.

O documento separa explicitamente:

- decisões já estabelecidas pelo domínio, que devem ser formalizadas na
  implementação;
- decisões ainda abertas, que não devem ser escolhidas pelo agente ou pelo
  implementador sem manifestação do responsável pelo domínio.

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
- um novo Patrimônio é criado ou vinculado como unidade física substituta,
  com origem de incorporação decorrente de `SUBSTITUICAO_EM_GARANTIA`, e não
  como nova aquisição contratual ordinária;
- o novo Patrimônio recebe novos Tombos quando for tombável;
- Tombos antigos não migram para a unidade substituta;
- Tombo nunca é reutilizado;
- deve existir vínculo histórico navegável entre Patrimônio antigo e substituto;
- a origem da nova unidade mantém referência explícita ao Patrimônio
  substituído, à Solicitação/fluxo de Manutenção, à ocorrência ou atendimento
  de garantia e aos documentos/evidências aplicáveis;
- a operação não consome artificialmente saldo de Contrato de aquisição;
- fatos históricos do Patrimônio antigo permanecem imutáveis;
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
continuidade operacional do anterior, criando ou vinculando a unidade
substituta e mantendo a relação histórica entre os dois.

O Command não corrige o Patrimônio antigo, não copia seu Tombo, não apaga sua
composição histórica e não simula uma compra ou um novo consumo do Contrato de
aquisição.

### 2.4 Ator, competência e relação com a Manutenção

O contexto operacional é Patrimônio/Manutenção. A operação deve exigir sessão,
Usuário ativo, Membership e escopo compatíveis com o Patrimônio antigo e com a
Solicitação relacionada.

O executor é o Time PATRIMÔNIO, após autorização da GERÊNCIA. A operação não é
automaticamente exclusiva do papel `LIDER`; continuam obrigatórios sessão,
Usuário ativo, Membership, escopo e a validação da autorização no backend e nas
camadas de Application/Domain.

A exigência de evidência formal específica para comprovar a ocorrência ou o
atendimento de garantia permanece como decisão de negócio. A persistência do
vínculo explícito, a criação do substituto pelo próprio Command e o limite da
autorização da GERÊNCIA são decisões já fechadas.

### 2.5 Pré-condições

Pré-condições derivadas das decisões já existentes:

- o Patrimônio antigo existe;
- o Patrimônio antigo é tombável ou não tombável conforme sua própria regra de
  Material;
- existe uma Solicitação/fluxo de Manutenção relacionado;
- existe referência à ocorrência ou ao atendimento de garantia que originou a
  substituição;
- existe autorização da GERÊNCIA para a substituição;
- o alvo do Patrimônio está vinculado à Solicitação;
- a estratégia persistida para o alvo é `GARANTIA`;
- o Patrimônio antigo ainda não foi encerrado por essa substituição;
- o equipamento substituto ainda não foi incorporado por esta substituição;
- os fatos históricos anteriores estão íntegros;
- a operação possui chave de idempotência e `correlation_id`.

Ainda requer decisão humana qual evidência formal comprova a ocorrência ou o
atendimento de garantia: laudo, ateste técnico, aprovação externa, documento
de garantia ou combinação desses fatos. A referência ao fato de garantia e a
origem `SUBSTITUICAO_EM_GARANTIA`, porém, são obrigatórias e já decididas.

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
| evidências/documentos | condicional | comprova garantia ou reconhecimento técnico |
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
4. validar a evidência ou reconhecimento exigido, depois que essa decisão for
   fechada;
5. encerrar o Patrimônio antigo com motivo
   `SUBSTITUICAO_EM_GARANTIA`, sem apagar seus fatos;
6. encerrar os Tombos antigos quando aplicável, sem reutilizá-los;
7. criar o Patrimônio substituto, dentro desta transação, com origem
   `SUBSTITUICAO_EM_GARANTIA`;
8. criar novos Tombos quando a regra de tombabilidade exigir;
9. registrar a relação histórica antigo → substituto e os vínculos com a
   Solicitação/Manutenção, autorização, ocorrência de garantia e evidências;
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

A escolha depende da decisão sobre a origem do novo Patrimônio e sobre qual
fato autoriza a substituição. O contrato OpenAPI deve ser criado somente depois
da escolha do limite do Command.

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
- Kit/Composto não recebe edição retroativa da configuração histórica.

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

| Caso | Efeito já definido | Decisão ainda necessária |
|---|---|---|
| Componente tombável | a nova unidade física possui nova identidade patrimonial e novo Tombo; o Tombo anterior não é reutilizado | como o componente anterior será tratado operacionalmente |
| Componente não individualizado/não tombável | não recebe Tombo individual; o histórico preserva Material, identificação disponível, componente anterior/substituto, datas, motivo, Manutenção e evidências aplicáveis | nenhuma decisão adicional de conteúdo histórico neste documento |
| Componente de Kit | a configuração histórica não é reescrita; a substituição cria nova versão da composição concreta do Patrimônio | nenhuma decisão adicional sobre reescrita da configuração histórica |

Não se deve implementar os três casos com o mesmo efeito por conveniência.

### 3.4 Atores e pré-condições

O contexto operacional é Patrimônio/Manutenção, com sessão, Membership e
escopo do Patrimônio. A substituição deve estar vinculada a uma Manutenção.
Uma OS somente é obrigatória quando a estratégia ou modalidade de atendimento
aplicável exigir OS.

Pré-condições já compatíveis com o domínio:

- Patrimônio existe;
- Manutenção relacionada existe;
- composição vigente existe quando a operação for troca de composição;
- linha/componente indicado pertence à composição vigente;
- Material substituto é compatível com a Classe/configuração;
- não há operação concorrente que tenha criado nova revisão desde a leitura;
- fatos históricos anteriores estão preservados.

Ainda requer decisão humana:

- quem pode executar e se requer `LIDER` ou Gerência;
- se o componente tombável anterior é encerrado, recolhido ou apenas deixa de
  integrar a composição;
- quais evidências adicionais são obrigatórias conforme a modalidade de
  atendimento.

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
- Patrimônio substituto, se já existente;
- quantidade;
- número de série, quando aplicável;
- justificativa e evidências;
- `occurred_at`;
- `correlation_id`;
- `idempotency_key`.

O payload final depende da decisão sobre componente individualizado, Kit e
origem do substituto. Não aceitar simultaneamente campos mutuamente
excludentes sem uma regra explícita.

### 3.6 Transação conceitual

1. reservar idempotência;
2. bloquear o Patrimônio, a composição vigente e o componente concreto quando
   houver;
3. validar versão, autorização, compatibilidade e pré-condições;
4. criar nova revisão da composição, mantendo a revisão anterior;
5. para componente tombável, criar a nova unidade patrimonial com identidade e
   Tombo novos, sem reutilizar o Tombo anterior;
6. preservar a referência ao componente anterior e registrar seu efeito
   operacional conforme a decisão humana;
7. registrar o fato específico de substituição;
8. registrar auditoria e Outbox necessárias;
9. gravar resultado de idempotência;
10. commit.

Qualquer falha deve reverter a nova revisão, o vínculo do componente, o Tombo
novo e os fatos auxiliares. A revisão histórica anterior nunca deve ser
alterada para desfazer a operação.

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
Patrimônio identificado. Essa decisão depende do payload final.

## 4. Plano de Manutenção Preventiva

### 4.1 Decisões já existentes

Está definido que:

- o plano inicialmente é manual;
- a existência de possibilidade de manutenção preventiva no Material não é,
  sozinha, autorização para executar uma OS;
- preventiva não gera automaticamente uma OS sem decisão de negócio;
- a operação pode ser trabalhada em lote pela interface;
- uma OS pertence a uma única Entidade;
- a OS preventiva exige aprovação da Gerência antes da emissão, inclusive
  quando a interface permitir operação em lote;
- UTD/CERME não precisam de cadastro ou integração próprios na fase inicial.

O catálogo já possui a capacidade de indicar se um Material permite manutenção
preventiva, mas isso não define sozinho um Plano Preventivo.

### 4.2 Modelo conceitual mínimo, sem fechar regras novas

Para suportar uma implementação posterior, será necessário distinguir, no
mínimo:

- `PlanoPreventivo`: definição manual e versionável da política;
- alvo do plano: Material, Classe, Patrimônio ou Entidade, conforme decisão;
- vigência e periodicidade;
- ocorrência/previsão gerada pelo plano;
- ação operacional que transforma uma previsão em Solicitação de Manutenção;
- histórico de inclusão, suspensão, cancelamento, execução e reagendamento.

Ocorrências canceladas ou rejeitadas permanecem registradas no histórico. A
geração e a execução de uma ocorrência preventiva devem usar a política
transversal de `CommandId`/`Idempotency-Key` e proteção contra duplicação da
mesma ocorrência lógica.

Esses nomes são conceitos de análise, não nomes obrigatórios de tabelas ou
Classes. A especificação não escolhe ainda o modelo final.

### 4.3 Pontos para decisão — Plano Preventivo

1. Quem cria e altera um plano: Patrimônio, Gerência, ambos com papéis
   distintos ou outro time?
2. Quem pode ativar, suspender e cancelar um plano?
3. O escopo do plano pode ser Material Singular, Classe, Patrimônio,
   Entidade ou combinação desses níveis?
4. Um plano pode ter múltiplos escopos simultâneos? Em caso positivo, qual é a
   precedência quando houver conflito?
5. A periodicidade será intervalo fixo, calendário mensal/anual, leitura de
   uso, contador físico ou outra modalidade?
6. Qual fuso, calendário e tratamento de dias não úteis devem ser usados?
7. A vigência possui início obrigatório, fim opcional ou ambos obrigatórios?
8. Um Patrimônio incorporado depois da criação do plano entra automaticamente,
   entra somente após revisão manual ou nunca entra?
9. Quais estados permitem inclusão no plano: `EM_USO`, `RECOLHIDO`,
   `EM_MANUTENCAO`? Patrimônio `BAIXADO` deve ser sempre excluído?
10. O que acontece quando o Patrimônio já está em outra Manutenção preventiva
    ou corretiva na data prevista?
11. Suspensão pausa o calendário, cancela ocorrências futuras ou exige nova
    vigência? O período suspenso é preservado?
12. Reagendamento altera a ocorrência original, cria uma nova ocorrência ou
    registra uma correção vinculada?
13. A previsão é apenas um lembrete ou pode gerar uma Solicitação pré-preenchida
    para confirmação manual?
14. A decisão de criar a Solicitação ocorre por Patrimônio, por Entidade ou em
    lote? Como se respeita a regra de uma Entidade por OS?
15. Quais notificações são necessárias e quais são apenas projeções de leitura?

Nenhuma dessas respostas deve ser inferida somente da flag
`allowsPreventiveMaintenance` ou da feature flag `MANUTENCAO_PREVENTIVA`.

### 4.4 Testes previstos depois das decisões

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
- idempotência, concorrência e histórico.

## 5. SLA de atendimento interno UTD/CERME

### 5.1 Decisões já existentes

Está definido que:

- UTD e CERME são inicialmente unidades/atores externos ao GMAP;
- não haverá cadastro de Usuário UTD/CERME obrigatório na fase inicial;
- não haverá integração automática obrigatória;
- a estratégia de Manutenção pode direcionar o atendimento para UTD ou CERME;
- o GMAP pode acompanhar o atendimento sem transformar a unidade externa em
  um contexto IAM completo.

Também está explicitamente aberto o SLA interno de UTD/CERME. Nenhum prazo
numérico deve ser introduzido por implementação.

### 5.2 Modelo conceitual mínimo

Antes de escolher prazos, o modelo precisa distinguir:

- política de SLA aplicável;
- obrigação/relógio de atendimento;
- marcos observáveis, como aceite, início e conclusão;
- períodos de pausa e retomada;
- vencimento calculado;
- ocorrência de atraso e justificativa;
- reagendamento e seu responsável;
- evidência manual do avanço externo.

O SLA é associado ao atendimento/encaminhamento da Manutenção para a unidade
UTD ou CERME correspondente. Não é associado diretamente ao Patrimônio.
Políticas de SLA são versionadas; alterações posteriores não reescrevem o
histórico nem as métricas dos atendimentos anteriores.

O SLA deve ser uma camada de acompanhamento. Ele não deve alterar sozinho o
estado de uma Solicitação ou OS sem um Command de negócio explícito.

### 5.3 Pontos para decisão — SLA UTD/CERME

1. O relógio começa na definição da estratégia, na emissão da Solicitação, no
   envio à unidade ou no aceite manual da UTD/CERME?
2. Existem prazos separados para aceite, início, atendimento e conclusão?
3. O SLA varia por prioridade, Classe, Material, tipo de atendimento ou
   unidade? Qual é a precedência entre políticas?
4. O prazo usa horas corridas, horas úteis ou calendário específico?
5. Qual fuso e calendário de feriados se aplicam?
6. Quais eventos pausam o relógio: aguardando peça, Entidade, fornecedor,
   autorização ou outro motivo?
7. Quem inicia, pausa, retoma e encerra o relógio quando não existe Usuário
   UTD/CERME no sistema?
8. A ausência de aceite é atraso, pendência manual ou apenas informação?
9. O vencimento produz alerta, indicador, escalonamento ou transição de estado?
10. Quem pode reagendar e qual justificativa/evidência é obrigatória?
11. UTD e CERME compartilham a mesma política ou possuem políticas distintas?
12. Qual é a regra para cancelamento, substituição de estratégia e encerramento
    sem conclusão?
13. Quais métricas e notificações são necessárias e quais ficam para Reporting?

### 5.4 Testes previstos depois das decisões

- aplicação correta da política;
- cálculo de prazo com calendário definido;
- pausas e retomadas;
- atraso e justificativa;
- reagendamento versionado;
- ausência de integração externa;
- idempotência de registros manuais;
- concorrência em atualização do relógio;
- projeções e métricas sem alterar o fato transacional.

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

Antes de fixar a API, deve-se fechar:

- limite do Command;
- recurso principal da operação;
- formato de evidências/documentos;
- `Idempotency-Key` e `correlation_id`;
- códigos HTTP e erros de domínio;
- contrato OpenAPI.

## 7. Impacto previsto na implementação atual

Esta seção não autoriza alterações. Ela antecipa o impacto para uma fase
posterior.

### Commands e Application

Prováveis Commands novos:

- `SubstituirPatrimonioEmGarantia`;
- `SubstituirComponentePatrimonial`;
- Commands de criação, ativação, suspensão, cancelamento e ocorrência de
  `PlanoPreventivo`, após as decisões humanas;
- Commands de iniciar, pausar, retomar, reagendar e registrar marco de SLA,
  após as decisões humanas.

### Aggregates e domínio

Prováveis áreas afetadas:

- `Patrimonio` e seu ciclo de encerramento;
- composição versionada de Patrimônio;
- vínculo semântico entre Patrimônio antigo e substituto;
- relação entre Manutenção, alvo e garantia;
- novo agregado de Plano Preventivo, se aprovado;
- novo conceito de relógio/política de SLA, se aprovado.

### Persistência e migrations

Provavelmente serão necessárias alterações para:

- registrar substituição integral e vínculo antigo → novo;
- registrar motivo de encerramento sem confundi-lo automaticamente com Baixa;
- registrar substituição de componente quando a composição atual não suportar
  todos os fatos necessários;
- armazenar plano, alvo, vigência, ocorrência e histórico preventivo, caso o
  modelo escolhido exija persistência própria;
- armazenar política, marcos, pausas e justificativas de SLA, caso aprovados.

As migrations devem ser desenhadas somente após o fechamento das decisões de
modelo e cardinalidade.

### API, eventos e testes

Serão necessários, conforme o desenho aprovado:

- handlers REST e contratos OpenAPI;
- adapters PostgreSQL transacionais;
- auditoria e Outbox dos fatos de negócio;
- testes unitários, autorização, idempotência, concorrência, rollback e
  integração PostgreSQL;
- E2E somente para fluxos críticos escolhidos.

Não há Read Model obrigatório novo antes de existir uma necessidade de leitura
com escopo, campos e métrica definidos.

## 8. Matriz de maturidade da especificação

| Item | Antes | Depois | Ainda requer decisão humana? |
|---|---|---|---|
| Substituição integral em garantia | Regra conceitual de criar novo Patrimônio/Tombo e preservar o antigo | Command, origem, autorização, executor, vínculos explícitos, criação transacional, invariantes, estado/motivo, idempotência, concorrência, eventos, erros e testes foram estruturados | Sim: qual evidência formal de garantia é obrigatória |
| Substituição de componente | Distinção geral entre peça técnica e componente patrimonial | Manutenção obrigatória, OS condicional, casos tombável/não tombável/Kit, nova identidade/Tombo, revisão histórica e transação foram separados | Sim: competência/gate, tratamento operacional do componente anterior e evidências adicionais |
| Plano Preventivo | Manual, sem OS automática; detalhes finais abertos | Modelo conceitual, aprovação da Gerência antes da OS, histórico de cancelamento/rejeição e idempotência foram formalizados | Sim: criação, escopo, periodicidade, vigência, inclusão, conflitos, suspensão, reagendamento, geração manual e notificações |
| SLA UTD | Unidade externa, sem integração obrigatória; SLA aberto | Modelo de política/relógio/marcos, associação ao atendimento da unidade e versionamento histórico | Sim: marcos, prazos, calendários, pausas, responsáveis, atraso, reagendamento, política e métricas |
| SLA CERME | Unidade externa, sem integração obrigatória; SLA aberto | Mesmo detalhamento, permitindo política própria ou compartilhada sem escolher uma delas | Sim: marcos, prazos, calendários, pausas, responsáveis, atraso, reagendamento, política e métricas |

## 9. Pontos que exigem decisão do responsável pelo domínio

As perguntas abaixo são as únicas decisões de negócio ainda pendentes neste
documento. Elas não devem ser respondidas pelo agente ou pelo implementador.

### A. Substituição de Patrimônio/Componente

1. Qual evidência formal é obrigatória para comprovar a ocorrência ou o
   atendimento de garantia?
2. Quem pode executar a substituição de componente e qual gate de autorização é
   exigido?
3. Qual é o tratamento operacional do componente tombável anterior: encerrado,
   recolhido ou apenas retirado da composição?
4. Quais evidências adicionais são obrigatórias conforme a modalidade de
   atendimento da substituição de componente?

### B. Plano Preventivo

1. Quem cria e altera um plano?
2. Quem pode ativar, suspender e cancelar um plano?
3. O escopo pode ser Material Singular, Classe, Patrimônio, Entidade ou
   combinação desses níveis?
4. Um plano pode ter múltiplos escopos? Qual precedência resolve conflitos?
5. Qual periodicidade será usada: intervalo, calendário, leitura de uso,
   contador físico ou outra modalidade?
6. Qual fuso, calendário e tratamento de dias não úteis serão usados?
7. A vigência terá início obrigatório, fim opcional ou ambos obrigatórios?
8. Patrimônio incorporado depois entra automaticamente, após revisão manual ou
   nunca entra?
9. Quais estados permitem inclusão no plano? Patrimônio `BAIXADO` será sempre
   excluído?
10. O que acontece quando o Patrimônio já está em outra Manutenção na data
    prevista?
11. Suspensão pausa o calendário, cancela ocorrências futuras ou exige nova
    vigência?
12. Reagendamento altera a ocorrência original, cria outra ou registra correção
    vinculada?
13. A previsão será apenas lembrete ou poderá gerar Solicitação pré-preenchida
    para confirmação manual?
14. A Solicitação será criada por Patrimônio, Entidade ou lote, respeitando uma
    única Entidade por OS?
15. Quais notificações são necessárias e quais ficam apenas como projeções de
    leitura?

### C. SLA UTD/CERME

1. Quando começa o relógio: estratégia, Solicitação, encaminhamento ou aceite?
2. Existem prazos separados para aceite, início, atendimento e conclusão?
3. O SLA varia por prioridade, Classe, Material, tipo de atendimento ou
   unidade? Qual a precedência?
4. O prazo usa horas corridas, horas úteis ou calendário específico?
5. Qual fuso e calendário de feriados se aplicam?
6. Quais eventos pausam o relógio?
7. Quem inicia, pausa, retoma e encerra o relógio sem Usuário UTD/CERME?
8. Ausência de aceite é atraso, pendência manual ou apenas informação?
9. O vencimento produz alerta, indicador, escalonamento ou mudança de estado?
10. Quem pode reagendar e qual justificativa/evidência é obrigatória?
11. UTD e CERME compartilham a mesma política ou possuem políticas distintas?
12. Qual regra vale para cancelamento, troca de estratégia e encerramento sem
    conclusão?
13. Quais métricas e notificações são necessárias e quais ficam para Reporting?

Até essas decisões serem fechadas, não se deve tratar os itens como “prontos
para implementação” apenas porque aparecem na lista de entregas da Fase 7.
