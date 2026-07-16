# /docs — curated assistant runtime documents

Only files explicitly allow-listed by `vault/assistant/processes/registry.json` are loaded as runtime policy. Files elsewhere in this directory, and the repository-level `docs/` tree, are not loaded implicitly.

Use `/docs` for stable authority, product, methodology, and boundary context. Do not use project implementation plans as runtime policy.

## Document families

| Document | Use when | Authority boundary |
|---|---|---|
| `/docs/privacy-boundary.md` | Employee asks what company/methodologist sees or what is stored | Current prototype privacy explanation only |
| `/docs/authority-and-mutability.md` | Every assistant request | Namespace authority, owner scope, and mutation boundaries |

Current state comes from `/proc`. Mutations go through `/bin`. Business-process selection comes from `/processes`.
