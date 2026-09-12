# ADR-004 - Transactional Outbox

Status: Aceito

## Contexto

Efeitos externos, notificacoes e jobs nao devem ocorrer dentro da transacao de negocio. Falha de comunicacao nao pode apagar fato ocorrido.

## Decisao

Usar Transactional Outbox no PostgreSQL para registrar eventos/efeitos derivados na mesma transacao que grava o fato essencial. Um Worker Node.js processa eventos apos commit.

Broker externo nao sera usado inicialmente.

## Consequencias

- Comandos criticos gravam fato de negocio e outbox de forma atomica quando aplicavel.
- Efeitos externos sao assincronos e idempotentes.
- Falha no envio/processamento gera retry ou estado FAILED, sem reverter o fato de dominio.
- Kafka/RabbitMQ so entram com necessidade concreta e novo ADR.
