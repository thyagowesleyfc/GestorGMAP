# GESTOR GMAP — Setup dos Specs para Codex CLI

Estrutura esperada após copiar este pacote para a raiz do repositório:

```text
AGENTS.md
README-SETUP.md
docs/
└── specs/
    ├── 01-dominio-consolidado.md
    ├── 02-especificacao-tecnica-consolidada.md
    ├── 03-plano-implementacao.md
    ├── 04-fases-implementacao.md
    └── 05-prompt-inicial-codex.md
```

## Windows 10 / PowerShell

Se o ZIP foi extraído em uma pasta temporária, execute na raiz do projeto:

```powershell
New-Item -ItemType Directory -Force .\docs\specs | Out-Null
Copy-Item "CAMINHO_EXTRAIDO\AGENTS.md" .\AGENTS.md -Force
Copy-Item "CAMINHO_EXTRAIDO\docs\specs\*.md" .\docs\specs\ -Force
```

Depois:

```powershell
git status
codex
```

Use o conteúdo de `docs/specs/05-prompt-inicial-codex.md` como primeiro prompt.

O usuário mantém controle manual sobre branch, commit, merge e push.

## Baseline de infraestrutura

A especificação atual usa:

```text
VPS 1 → Coolify + Traefik + GMAP Web/API + Worker + Scheduler
VPS 2 → PostgreSQL PRIMARY nativo
VPS 3 → PostgreSQL STANDBY + Grafana/Loki/Prometheus + contingência
Cloudflare R2 → documentos e backups
```

O ambiente local continua Windows 10 + PowerShell + Docker Desktop/Compose.
