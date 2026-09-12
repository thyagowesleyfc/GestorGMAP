# ADR-003 - Prisma com escape para SQL especializado

Status: Aceito

## Contexto

O projeto precisa de produtividade em persistencia comum, migrations e queries normais, mas tambem precisa de locks, agregacoes e consultas especializadas que nem sempre cabem bem em ORM.

## Decisao

Usar Prisma como ORM padrao para persistencia comum, relacoes, migrations, transactions, CRUD e queries normais.

Permitir SQL especializado, TypedSQL ou raw SQL quando houver necessidade concreta, como `SELECT ... FOR UPDATE`, reporting pesado, agregacoes, bulk operations e queries que o Prisma nao represente adequadamente.

## Consequencias

- Prisma implementa persistencia; ele nao define o dominio.
- Repositories sao especificos e seletivos, por Aggregate quando agregarem valor.
- Nao criar `GenericRepository<T>` obrigatorio.
- SQL especializado deve ser testado e manter os invariantes do modulo dono.
