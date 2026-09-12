# ADR-010 - Observabilidade Grafana/Loki/Prometheus/Alloy

Status: Aceito

## Contexto

O GMAP precisa de logs, metricas, alertas tecnicos e rastreabilidade por `correlation_id`, mas a baseline deve permanecer simples e operavel.

## Decisao

Usar observabilidade simples com:

- logs estruturados com `timestamp`, `level`, `service`, `environment`, `correlation_id`, `event` e `message`;
- Grafana Alloy para coleta nas VPS;
- Loki para logs;
- Prometheus para metricas;
- Grafana para visualizacao.

## Consequencias

- Grafana/Loki/Prometheus nao ficam publicos sem protecao de acesso.
- Monitorar requests/latencia/HTTP 5xx, jobs, Outbox, Worker, recursos das VPS, PostgreSQL, replication lag, R2 e backups.
- Erro tecnico nao expoe detalhe interno ao usuario e registra `correlation_id`.
- Nao criar cluster de observabilidade inicialmente.
