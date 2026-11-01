# Token usage: Strangle Pulse Phases 1-3, baseline

Source: usage records in the session transcript (API-reported counts, deduplicated by request id).

- **Scope:** one session covering Phase 1 (collector), Phase 2 (metrics), Phase 3A (indicators + backtest) and Phase 3B (live gate). Totals below cover all of it.
- **Tasks completed:** 5 in Phase 3 (3A: 2, 3B: 3). The Phase 1 and 2 ledgers were deleted, so their task count is not recoverable.
- **Models:** claude-opus-5-5 (778 messages), claude-sonnet-5-5 (533), claude-haiku-5-5 (4). Effort level: not recorded.
- **Graphify:** not active (setup = baseline).
- **Subagents spawned:** 36 (transcript files).
- **Wall-clock:** 17.2 h from first to last message (2026-10-31 09:16 UTC to 2026-11-01 02:31 UTC), including idle time and two usage-limit waits.

| | Requests | Output | Cache writes | Cache reads |
|---|---|---|---|---|
| Main session | 216 | 236,681 | 1,853,276 | 61,439,850 |
| Subagents | 324 | 593,123 | 3,399,362 | 23,276,277 |
| **Total** | **540** | **829,804** | **5,252,638** | **84,716,127** |

Per-unit averages (the session covers more than Phase 3, so per-task figures divide all-phase totals by Phase 3's 5 tasks and overstate; per-subagent is the cleaner figure):
- Per subagent (36): 16,476 output, 94,427 cache writes.
- Per Phase 3 task (5, overstated): 165,961 output, 1,050,528 cache writes.

Top 3 cost drivers:
1. Subagent implement-and-review loops: 71% of output and 65% of cache writes.
2. Main session re-reading a long context each turn: 61.4M cache reads over 216 requests.
3. Opus-class messages (778) on implementers and reviewers where a mid-tier model would do.
