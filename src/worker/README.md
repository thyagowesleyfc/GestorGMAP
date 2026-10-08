# Worker

Pasta reservada para o Worker Node.js do GESTOR GMAP.

A base de processamento da Outbox existe como um processador de lote reutilizavel. O worker tambem possui um roteador simples de handlers por `event_type` e `aggregate_type`, permitindo processar efeitos assincronos diferentes sem acoplar as regras em um unico handler.

`createLogisticsOutboxWorker` monta a composicao atual do Worker de Logistica com dependencias injetadas:

- `Pool` PostgreSQL;
- porta `EmailSender`;
- destinatarios do e-mail de entrega;
- contexto de Time/Gerencia para notificacoes internas.

Eventos cobertos nesta base:

- `logistics.delivery_registered`: monta e envia mensagem por uma porta `EmailSender`, ainda sem provider real de e-mail.
- `logistics.recollection_executed`: cria notificacao interna para a Gerencia.

Ainda nao ha loop de processo/container dedicado, leitura de env nem provider real de e-mail. Essa integracao operacional deve ser adicionada em incremento proprio, quando houver provider/configuracao real para os efeitos assincronos.
