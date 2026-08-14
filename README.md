# v61 — Global Foundation Cascade

Changes from v60:

- Keeps the same 8-way solver race and 5-second post-race optimizer budget.
- Expands Foundation Cascade: after any foundation move, v61 scans all four free cells and all eight exposed tableau tops for every card that is currently legal for foundation, regardless of suit.
- Candidate promotions are accepted only if replaying the entire modified solution still produces a valid complete solve.
- Mobility cascade seeds remain enabled, so freeing a cell or exposing a card can seed newly legal large supermoves into Best-First.
- Cache-bust versions advanced to v61 for iPhone Safari/Chrome.

This targets the observed case where 7H reached foundation and exposed AD, but v60 ignored AD because it was a different suit from the triggering card.
