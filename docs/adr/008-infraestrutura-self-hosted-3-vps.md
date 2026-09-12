# ADR-008 - Infraestrutura self-hosted com 3 VPS + Coolify/Traefik

Status: Aceito

## Contexto

A baseline operacional definida nas specs e self-hosted, simples e sem Kubernetes. O projeto precisa de deploy reproduzivel, TLS, isolamento do banco e contingencia basica.

## Decisao

Usar infraestrutura self-hosted com tres VPS Linux:

- VPS 1: Coolify + Traefik + Web/API + Worker + Scheduler.
- VPS 2: PostgreSQL PRIMARY nativo.
- VPS 3: PostgreSQL STANDBY + Grafana/Loki/Prometheus + capacidade de contingencia.

Cloudflare DNS fica na borda; R2 fica externo para documentos e backups.

## Consequencias

- Coolify gerencia deploy, variaveis/secrets, containers, dominios e TLS.
- Traefik e o proxy padrao inicial.
- Nginx/Envoy nao entram sem necessidade concreta e novo ADR.
- Kubernetes nao sera adotado inicialmente.
