# Local repository provider icons

The application bundles these SVGs locally; rendering a repository link does not request a provider favicon or other external image.

| Provider | Bundled file | Source and transformation |
| --- | --- | --- |
| GitHub | `github-black.svg`, `github-white.svg` | Official Invertocat from GitHub’s logo archive, unchanged; selected for the active theme. |
| CNB | `cnb-color.svg` | Official icon-only color SVG, unchanged. |
| Gitee | `gitee.svg` | Original symbol group from the official SVG; paths/colors unchanged, wordmark omitted. |
| GitCode | `gitcode.svg` | Original symbol path from the official documentation SVG; paths/color unchanged, wordmark omitted. |

Retrieved 2026-10-25. `sources.json` records the original downloads, discovery pages and transformations. `validation.json` records source-asset hashes and SVG safety checks; these provenance records also include source candidates that are not bundled here. The application imports only the five SVGs listed above.

Each bundled SVG was parsed and checked for scripts, event attributes, foreign content, embedded images, external references, imported CSS and entities. Provider/repository accessible labels remain on the links. Preserve the original brand colors and the user-facing GitCode provider name and saved repository URLs.
