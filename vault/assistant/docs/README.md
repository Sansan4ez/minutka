# /docs — curated «Минутка» runtime documents

Only files explicitly allow-listed by `vault/assistant/processes/registry.json` are loaded as «Минутка» runtime policy. This `README.md`, files elsewhere in this directory, and the repository-level `docs/` tree are developer documentation and are not loaded implicitly.

Use `/docs` for stable authority, product, methodology, and boundary context. Do not use project implementation plans as runtime policy.

## Document families

| Document | Use when | Authority boundary |
|---|---|---|
| `/docs/privacy-boundary.md` | Employee asks what is stored or which providers receive data | Current pilot privacy explanation only |
| `/docs/authority-and-mutability.md` | Every «Минутка» request | Namespace authority, employee scope, and mutation boundaries |
| `/docs/product-boundary.md` | Optional product scope and external-action boundary | Load only if explicitly added to the registry |

Current state comes from `/proc`. Mutations go through `/bin`. Business-process selection comes from `/processes`.
