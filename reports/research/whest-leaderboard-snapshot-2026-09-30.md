# WhestBench public leaderboard snapshot — 2026-09-30

Read-only public snapshot captured 2026-09-30 from AIcrowd's Phase 2
leaderboard. Scores are lower-is-better adjusted scores; this snapshot is a
moving external benchmark, not a reproducible local evaluation.

| Rank | Team | Adjusted score | Entries | Latest visible submission |
| ---: | --- | ---: | ---: | --- |
| 1 | J2W | `1.6e-9` | 361 | 2026-09-29 18:17 UTC |
| 2 | Luna | `1.9e-9` | 13 | 2026-09-27 06:44 UTC |
| 2 | marius_binner | `1.9e-9` | 176 | 2026-09-29 17:17 UTC |
| 4 | suliman_tadros | `2.0e-9` | 74 | 2026-09-28 04:30 UTC |
| 5 | mliston | `2.1e-9` | 61 | 2026-09-28 02:44 UTC |

The leaderboard's rank-1 “View” link resolved to public submission **333022**.
The public page did not expose the estimator source in the retrieved view, so
no implementation technique is attributed to J2W from this evidence alone.

Our historical best-known submission remains **332337** at
`5.418168137938331e-9`, based on our local AIcrowd receipt. The newer public
leaderboard makes `1.6e-9` the current aspirational comparator; do not rewrite
the historical result or imply our submission has a verified current rank.

## Research lead, not a claim about the leaders' code

The public 504aldo Phase 2 write-up reports that its K3 plus memoryless-K4
closure reached an estimated adjusted-score floor around `4.9e-9`, and
speculates that the strongest methods preserve higher-order information beyond
memoryless K4 and retain old-source content. This is the authors' hypothesis,
not verified knowledge of J2W's or any other leader's implementation. It does
suggest that further tuning of our current V29/Strassen compute knobs is
unlikely to close the gap; prioritize testing a distinct persistent
higher-moment or old-source representation, with a falsifiable paired screen.

The live challenge announcement states that Phase 2 permits **10 submissions
per team per UTC day**, consistent with the local CLI cap. This is shared across
team members, so local project history alone cannot account for submissions
made elsewhere on the team.

Sources:

- [AIcrowd Phase 2 leaderboard](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/leaderboards)
- [AIcrowd submission 333022](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/submissions/333022)
- [504aldo Phase 2 estimator and measured dead ends](https://discourse.aicrowd.com/t/everything-we-tried-a-factorized-k-3-cumulant-propagation-estimator-at-0-25-x-b-where-its-flops-go-and-25-measured-dead-ends-team-504aldo-rank-10/18218)
- [Official Phase 2 launch, rules, and submission cap](https://discourse.aicrowd.com/t/arc-white-box-estimation-challenge-is-now-open/17997)
