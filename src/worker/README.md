# Worker

Pasta reservada para o Worker Node.js do GESTOR GMAP.

A base de processamento da Outbox existe como um processador de lote reutilizavel. O worker tambem possui um roteador simples de handlers por `event_type` e `aggregate_type`, permitindo processar efeitos assincronos diferentes sem acoplar as regras em um unico handler.

`resolveLogisticsOutboxWorkerConfig` valida as variaveis operacionais do Worker de Logistica (`DATABASE_URL`, `GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS`, `GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT`, `GMAP_OUTBOX_BATCH_SIZE`) e as credenciais SMTP usadas pelo adapter de e-mail (`GMAP_SMTP_HOST`, `GMAP_SMTP_PORT`, `GMAP_SMTP_SECURE`, `GMAP_SMTP_FROM`, `GMAP_SMTP_USERNAME`, `GMAP_SMTP_PASSWORD`).

`runLogisticsOutboxBatch` executa um unico lote configurado, sem loop continuo.

`runLogisticsOutboxLoop` executa lotes repetidamente ate um `AbortSignal` ser abortado. Ele nao implementa retry local para falhas de infraestrutura: erros do processador propagam para o processo supervisor, enquanto retry/FAILED de eventos continua sendo responsabilidade da politica da Outbox. O comando `npm run worker:logistics:outbox:loop` inicia esse processo continuo e encerra limpo com `SIGINT`/`SIGTERM`.

`createConfiguredLogisticsOutboxWorker` monta a composicao operacional de lote unico a partir do ambiente: cria o `Pool` PostgreSQL, instancia `SmtpEmailSender`, monta `createLogisticsOutboxWorker` e expoe `close()` para encerrar conexoes.

`runConfiguredLogisticsOutboxBatch` executa um lote com essa composicao configurada e sempre chama `close()` ao final, inclusive em falhas de processamento. O comando `npm run worker:logistics:outbox:batch` dispara exatamente um lote e retorna codigo 1 somente quando a execucao do worker falha.

`createLogisticsOutboxWorker` monta a composicao atual do Worker de Logistica com dependencias injetadas e restringe o processamento aos eventos configurados para este worker:

- `Pool` PostgreSQL;
- porta `EmailSender`;
- destinatarios do e-mail de entrega;
- contexto de Time/Gerencia para notificacoes internas.

`SmtpEmailSender` implementa a porta `EmailSender` com `nodemailer` e recebe a configuracao por `GMAP_SMTP_*`. Usuario e senha SMTP sao opcionais, mas devem ser informados em conjunto quando houver autenticacao.

Variaveis locais esperadas para o e-mail:

- `DATABASE_URL`: obrigatoria.
- `GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS`: obrigatoria; lista separada por virgula, com ao menos um e-mail.
- `GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT`: obrigatoria; identifica o contexto de Time/Gerencia das notificacoes.
- `GMAP_OUTBOX_BATCH_SIZE`: opcional; padrao `10`; inteiro entre `1` e `100`.
- `GMAP_SMTP_HOST`: obrigatoria.
- `GMAP_SMTP_PORT`: obrigatoria; inteiro entre `1` e `65535`.
- `GMAP_SMTP_SECURE`: opcional; padrao `false`; aceita `true` ou `false`.
- `GMAP_SMTP_FROM`: obrigatoria.
- `GMAP_SMTP_USERNAME` e `GMAP_SMTP_PASSWORD`: opcionais, mas sempre em conjunto; senha SMTP e URL de banco de producao nao devem ser versionadas.

Eventos cobertos nesta base:

- `logistics.delivery_registered`: cria notificacao interna para a Gerencia e monta/envia mensagem por uma porta `EmailSender`.
- `logistics.recollection_executed`: cria notificacao interna para a Gerencia.
- `requests.material_request_finalized`: cria notificacao interna para ciencia da Gerencia.

Ainda nao ha processo/container dedicado nem scheduler externo. Essa integracao operacional deve ser adicionada em incremento proprio para execucao supervisionada em DEV/HML/PROD.
