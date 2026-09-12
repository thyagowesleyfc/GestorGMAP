# ADR-009 - PostgreSQL primary/standby com failover manual

Status: Aceito

## Contexto

O banco de producao nao deve ficar exposto publicamente e precisa de contingencia. Ao mesmo tempo, cluster HA automatico aumenta complexidade operacional inicial.

## Decisao

Usar PostgreSQL PRIMARY nativo na VPS 2 e PostgreSQL STANDBY na VPS 3 com streaming replication. O failover inicial sera manual, documentado e ensaiado em HML antes de PROD.

A aplicacao acessa o banco por rede privada do provedor ou WireGuard.

## Consequencias

- Replicacao reduz perda provavel em falha isolada, mas nao substitui backup.
- Backups externos no R2 continuam obrigatorios e devem ter restore testado.
- Promocao de standby, troca de endpoint e health/smoke checks ficam em runbook.
- Patroni/etcd/Consul ou HA automatico exigem necessidade comprovada e novo ADR.
