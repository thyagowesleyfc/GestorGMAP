# ADR-007 - PWA offline seletiva

Status: Aceito

## Contexto

O modo offline e necessario apenas para Fiscalizacao/Tombamento relacionado, em visitas com conectividade intermitente curta. Offline nao deve ampliar escopo nem sobrescrever fatos oficiais posteriores.

## Decisao

Implementar PWA offline seletiva somente para o fluxo de Fiscalizacao/Tombamento relacionado, quando a fase correspondente chegar.

O pacote offline deve ser minimo, expirar, usar fila local com UUID por operacao, registrar `observed_at`/`synced_at` e sincronizar em lotes.

## Consequencias

- Login, autorizacao e download inicial exigem conexao.
- Observacao offline nunca sobrescreve movimento oficial posterior a versao de referencia.
- Conflitos geram `RECONCILIATION_REQUIRED`, nao rollback silencioso.
- Nao criar aplicativo mobile nativo inicialmente.
