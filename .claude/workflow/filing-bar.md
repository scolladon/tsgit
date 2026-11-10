# Filing bar — impact-triage context (ADR-1170)

A deferred impact that reproduces gets a `backlog:*` verdict only when it is at or above the
bar. Below the bar its verdict is `reject`, rationale `below filing bar (ADR-1170): <class>`,
and the session appends the drafted entry, proof included, under that class's heading in
`docs/known-divergences.md` in the same `docs(<slug>): file triaged impacts` commit.

## At or above the bar → backlog

1. A failure a user reported.
2. A consumer-facing API bug: a call that cannot be expressed, or a result whose shape or
   order differs from git's data.
3. Data integrity: tsgit writes, deletes or leaves on-disk state that git would not.
4. A wrong result or refusal mismatch on a **well-formed repository** with an input a caller
   plausibly sends.
5. A measured performance cost on a common caller path: status, add, commit, checkout, log,
   diff, merge, rebase, fetch, clone, push.

## Below the bar → ledger class

| class | signal |
|---|---|
| Corrupt, forged or unreadable input | the repro plants a damaged object, ref, index or state file, or `chmod 000` |
| Message only | exit code and data match; only wording or the named path differs |
| Rare configuration and edge input | well-formed, but a layout, config or argument shape few callers produce |
| Performance off the hot path | measured on a command outside the list in rule 5 |
| Feature gaps | git supports a form tsgit does not offer, and no caller asked |

A spike whose mechanism is unknown follows the same split: below the bar it is a ledger row,
not a `backlog:spike`.

## Net-zero cap

Count the backlog ids this run ships (ticked `[x]`). If the `backlog:*` verdicts outnumber
them, keep the highest-ranked ones (rank rule in `docs/BACKLOG.md` § Release order) and
re-verdict the rest `reject`, rationale `over net-zero cap (ADR-1170)`, ledger row included.
