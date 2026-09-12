# ADR-005 - Cloudflare R2 / storage S3-compatible para documentos

Status: Aceito

## Contexto

Documentos privados, evidencias e backups externos precisam ficar fora do filesystem das VPS para reduzir perda conjunta com o host e manter durabilidade operacional.

## Decisao

Usar Cloudflare R2 para documentos e backups externos. A Application Layer depende de uma porta abstrata de storage; a infraestrutura implementa adapter S3-compatible.

## Consequencias

- Bytes de documentos ficam no R2; PostgreSQL guarda metadados e referencias.
- Buckets e credenciais sao separados por ambiente.
- Uploads devem ser validados e documentos privados nao ficam publicos.
- Troca futura de provedor S3-compatible deve preservar a porta de storage.
