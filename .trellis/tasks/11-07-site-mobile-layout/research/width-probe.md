# Research: repository wrapping under platform font metrics

- Query: why does a 360px inventory row exceed the unchanged 156px density limit in Linux while Windows passes?
- Scope: exact committed source `573a76b0780342e194e16329bf091222f2d9998e`, original eight-site API fixture, read-only browser style injections.
- Date: 2026-11-07.

## Evidence

GitHub run `42327196037` failed at `light/360/sites` with 169px. Public artifact `13555837771` contains the successfully captured 390px inventory and 360px overview, each approximately 149px per standard row; the failing 360px inventory is not captured because the assertion precedes the screenshot. Logs confirm all other preceding gates passed. Artifact download reused an existing Git credential only in memory; signed redirect was followed without forwarding authorization. No credentials or signed URLs were printed or stored.

Main exported HEAD to `.artifacts/site-mobile-layout-baseline` and built it, excluding all parallel WIP. A probe reuses the existing layout script's setup and exact eight-site/two-job fixture, waits for fonts plus 450ms for shell transitions, then measures real DOM rectangles. CDP reports native Cascadia Code for the existing repository stack and Courier New for the controlled alternate. Controlled font injection affects only repository labels, not application source.

| Viewport / route / font | Metadata width | First row height | Repository line |
| --- | --- | --- | --- |
| 360 inventory, Cascadia Code | 222px | 144.5px | Same line |
| 360 inventory, Courier New | 222px | 164.5px | Second link moves down 20px |
| 390 inventory, Courier New | 252px | 144.5px | Same line |
| 360 overview, Courier New | 292px | 144.5px | Same line |
| 1440 inventory, either font | 531px | 75.5px | Same line |

At 360px, row width is 316px: 24px padding + 222px metadata + 8px gap + 62px controls. Cascadia link widths are 85.453125px and 126.46875px, plus 8px gap = 219.921875px. Courier New widths are 87.015625px and 129.03125px, plus 8px = 224.046875px. The 222px track therefore crosses a genuine wrap boundary. Secondary block height changes 38px -> 58px; metadata block 77.5px -> 97.5px. The full row increases exactly 20px.

## Candidate feasibility experiment

Injecting only phone grid rules (`.site-row-main {grid-column:1/-1}`, `.site-actions {grid-row:2}`, `.site-jobs {grid-column:1}`) moves controls beside tasks. It makes metadata 292px at 360 and 322px at 390 without reducing text/control size. Under Courier New the first row becomes 144.5px / 124.5px respectively. Desktop and overview geometry are unchanged. Actions are in a distinct cell; normal task chip widths 158px/170px fit the 222px job track. Long task names need a no-clipping regression since that track is narrower than before.

The 360px candidate screenshot was visually inspected. All measurements and exploratory scripts/screenshots remain ignored under `.artifacts/site-mobile-layout-*`; product source has not been changed in planning.

## Limits

This is a controlled local reproduction of the width-sensitive failure mechanism, not an identification of the exact Linux fallback font or a claim that Linux already passes. The extra platform baseline (~4px) remains attributed only to observed text metrics, not a proven particular CJK font. Actual GitHub evidence is required after implementation. Local WSL cannot start because its hypervisor is unavailable; no host virtualization changes were made. Do not install an arbitrary font into CI or relax the production density guard to hide the issue.
