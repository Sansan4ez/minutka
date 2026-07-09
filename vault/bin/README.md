# /bin — Minutka tool/action manifests

`/bin` describes typed application actions available to the agent runtime. These are not arbitrary shell commands.

Tools are mechanical. They do not decide business applicability. The SO-CoT conversation decision router and selected `/processes` decide whether an action is appropriate; application code validates input and enforces side effects.

| Tool manifest | Mutating | Purpose |
|---|---:|---|
| `/bin/route-conversation-decision.md` | No | Select processes and work/insight decisions. |
| `/bin/extract-insights.md` | Yes | Persist structured insight drafts after an allowed response. |
| `/bin/update-profile.md` | Yes | Save onboarding/profile fields through application validation. |
| `/bin/record-feedback.md` | Yes | Record employee feedback about a previous answer. |
