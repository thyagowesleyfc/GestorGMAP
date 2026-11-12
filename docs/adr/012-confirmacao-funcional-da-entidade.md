# ADR-012 - Confirmação funcional da Entidade

Status: Aceito

## Contexto

Uma Ordem de Serviço pertence a uma Entidade, que confirma funcionalmente o
atendimento depois da execução registrada pelo prestador. Essa confirmação é
um fato institucional da própria Entidade e deve existir antes de Patrimônio
atestar ou registrar a liquidação de glosa.

O responsável institucional da Entidade e um Usuário do GMAP são conceitos
diferentes. A responsabilidade patrimonial continua pertencendo à Entidade,
não à pessoa que assina, confirma ou é registrada como evidência. O
responsável somente se torna Usuário quando houver necessidade real de
autenticação e operação no GMAP.

## Decisão

Registrar a confirmação funcional como um fato persistente, único por Ordem de
Serviço, associado à Entidade da própria OS. O fato deve conter, no mínimo:

- a OS e a Entidade correspondente;
- data e hora da confirmação;
- o operador interno que registrou o fato;
- referência ou evidência da confirmação;
- correlação, auditoria e evento Outbox.

O operador interno autorizado registra a manifestação institucional no GMAP,
mas não se torna responsável institucional pela Entidade. A responsabilidade
patrimonial permanece atribuída à Entidade.

Confirmação, auditoria e Outbox devem ser persistidas atomicamente. O registro
é imutável e único por OS; eventual correção exige fluxo formal próprio.

A confirmação não cria estado novo na Ordem de Serviço. Os estados oficiais
permanecem compatíveis com os specs. Sua existência é uma pré-condição para o
ateste e para a liquidação de glosa por Patrimônio. A glosa pode ser registrada
diretamente após a confirmação ou depois do ateste; quando houver ateste, ele
permanece preservado.

## Consequências

- o sistema preserva separadamente o fato institucional e a identidade do
  operador que o registrou;
- uma OS não pode ser atestada nem ter glosa liquidada sem confirmação
  funcional persistida;
- a Entidade pode ser representada no registro sem que seus responsáveis sejam
  cadastrados como Usuários do GMAP;
- a confirmação pode ser consultada e auditada sem substituir os registros de
  execução, ateste ou glosa;
- correções posteriores não devem editar diretamente o fato original, a
  auditoria ou o Outbox.

## Rejeições explícitas

- Não criar um estado adicional na Ordem de Serviço apenas para representar a
  confirmação.
- Não criar um Time ou papel obrigatório chamado “Entidade”.
- Não exigir vínculo Usuário–Entidade para registrar a confirmação.
- Não tratar o operador interno como responsável institucional, signatário ou
  titular da responsabilidade patrimonial.
- Não converter automaticamente o responsável descritivo da Entidade em
  Usuário do GMAP.
- Não permitir ateste ou glosa com base somente em indicação textual,
  autorização do operador ou existência de usuário sem o fato persistido.
