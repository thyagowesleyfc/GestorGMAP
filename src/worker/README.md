# Worker

Pasta reservada para o Worker Node.js do GESTOR GMAP.

A base de processamento da Outbox existe como um processador de lote reutilizavel. O evento `logistics.delivery_registered` ja possui handler que monta e envia mensagem por uma porta `EmailSender`, ainda sem loop de processo/container dedicado e sem provider real de e-mail.

O worker funcional completo deve ser adicionado apenas quando o incremento de notificacao/e-mail assincrono exigir essa integracao operacional.
