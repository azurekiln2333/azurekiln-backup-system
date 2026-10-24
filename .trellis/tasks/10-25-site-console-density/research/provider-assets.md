# Provider icon evidence

Official sources checked on 2026-10-25 for planning. No assets downloaded and no runtime provider requests added.

- GitHub's official Brand Toolkit provides logo downloads and specifically describes secondary use to link to a profile/project. Use a local small mark with accessible provider/repository text; choose an appropriate existing light/dark asset rather than inventing a new logo. Sources: `https://brand.github.com/foundations/logo`, `https://docs.github.com/en/site-policy/other-site-policies/github-logo-policy`.
- CNB's official About page links to its official Logo page, which provides icon-only SVGs in black, color and white. An actual provider icon is available without relying on a third-party logo API. Sources: `https://docs.cnb.cool/zh/saas/about.html`, `https://docs.cnb.cool/zh/logo.html`.
- Gitee's official platform is `https://gitee.com/`. Do not treat third-party logo aggregators as official asset authority. Use an existing appropriately sourced project asset or verify a first-party asset during design convergence.
- GitCode's official documentation currently bears AtomGit branding. Do not silently rename the provider requested by the user or rewrite saved links to another host. Verify the intended supported host aliases in the repository-contract research. Source: `https://docs.gitcode.com/docs/help/home/protocol/terms-of-service/`.

Recommendation: bundle the chosen small provider icons locally, show an accessible provider/repository label or tooltip, and keep external navigation independent of icon loading. No remote favicon service, repository probe, account binding or token is needed for navigation metadata.
