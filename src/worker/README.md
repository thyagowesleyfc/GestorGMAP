# Worker

Pasta reservada para o Worker Node.js do GESTOR GMAP.

A base de processamento da Outbox existe como um processador de lote reutilizavel. O worker tambem possui um roteador simples de handlers por `event_type` e `aggregate_type`, permitindo processar efeitos assincronos diferentes sem acoplar as regras em um unico handler.

`resolveLogisticsOutboxWorkerConfig` valida as variaveis operacionais do Worker de Logistica (`DATABASE_URL`, `GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS`, `GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT`, `GMAP_OUTBOX_BATCH_SIZE`) e as credenciais SMTP usadas pelo adapter de e-mail (`GMAP_SMTP_HOST`, `GMAP_SMTP_PORT`, `GMAP_SMTP_SECURE`, `GMAP_SMTP_FROM`, `GMAP_SMTP_USERNAME`, `GMAP_SMTP_PASSWORD`).

`runLogisticsOutboxBatch` executa um unico lote configurado, sem loop continuo.

`createConfiguredLogisticsOutboxWorker` monta a composicao operacional de lote unico a partir do ambiente: cria o `Pool` PostgreSQL, instancia `SmtpEmailSender`, monta `createLogisticsOutboxWorker` e expoe `close()` para encerrar conexoes.

`runConfiguredLogisticsOutboxBatch` executa um lote com essa composicao configurada e sempre chama `close()` ao final, inclusive em falhas de processamento.

`createLogisticsOutboxWorker` monta a composicao atual do Worker de Logistica com dependencias injetadas e restringe o processamento aos eventos configurados para este worker:

- `Pool` PostgreSQL;
- porta `EmailSender`;
- destinatarios do e-mail de entrega;
- contexto de Time/Gerencia para notificacoes internas.

`SmtpEmailSender` implementa a porta `EmailSender` com `nodemailer` e recebe a configuracao por `GMAP_SMTP_*`. Usuario e senha SMTP sao opcionais, mas devem ser informados em conjunto quando houver autenticacao.

Eventos cobertos nesta base:

- `logistics.delivery_registered`: cria notificacao interna para a Gerencia e monta/envia mensagem por uma porta `EmailSender`.
- `logistics.recollection_executed`: cria notificacao interna para a Gerencia.
- `requests.material_request_finalized`: cria notificacao interna para ciencia da Gerencia.

Ainda nao ha loop de processo/container dedicado nem comando npm para disparo. Essa integracao operacional deve ser adicionada em incremento proprio para executar lotes continuamente ou via scheduler.
