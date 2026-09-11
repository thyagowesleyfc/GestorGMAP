# Módulos do GESTOR GMAP

Esta pasta organiza os Bounded Contexts oficiais do projeto.

Cada módulo deve evoluir de forma incremental. Quando houver comportamento real, módulos ricos podem criar subpastas conceituais como `domain`, `application`, `infrastructure` e `api`/`adapters`. Não crie camadas vazias nem abstrações sem uso.

Contextos iniciais:

- `organization` — ORGANIZATION / IAM
- `catalog` — CATALOG
- `entities` — ENTITIES
- `requests` — REQUESTS
- `contracts` — CONTRACTS
- `receiving` — RECEIVING
- `stock` — STOCK
- `logistics` — LOGISTICS
- `patrimony` — PATRIMONY
- `maintenance` — MAINTENANCE
- `inspection` — INSPECTION
- `reporting` — REPORTING
- `integrations` — INTEGRATIONS / MIGRATION
