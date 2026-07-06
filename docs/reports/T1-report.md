# T1 report — verify expected-strokes baseline anchors (D19)

**Model:** Sonnet (executed) + Opus (reviewer, this report). **Result:** verification complete.

## Files touched
- `shared/strategy/expected-strokes.ts` — anchor values + header D19 note.

## Tests
`bun test shared/strategy/` → **91 pass, 0 fail** (2048 expect() calls).

## Source of truth
- tee/fairway/rough/sand/recovery: Table 9, Broadie, *Assessing Golfer Performance on the PGA
  TOUR* (Interfaces, 2011) — the benchmark reprinted in *Every Shot Counts*.
- green (putting): Figure 1, Broadie, *Putts Gained* (2011).

## Findings & fixes
- **tee** — all 26 anchors already exact; unchanged.
- **fairway/rough/sand/recovery** — exact through 400 yd; the 420–600 yd tails ran low on the
  original recall pass; all 40 tail anchors corrected. Worst prior drift: sand 600 yd 5.52→6.10.
- **green** — 3/4/5/7 ft were 0.01 low (→1.05/1.14/1.24/1.43); 90 ft was 0.04 high (2.40→2.36,
  the only value outside the original ±0.03 estimate). Fixed.
- Kept per D18/D20: all in-source quirks; synthetic 1 ft = 1.00.

## Reviewer notes (Opus)
- **Decision-relevance:** every changed value is in a zone that does not affect an aim decision or
  a user-facing SG number. The 420–600 yd tails are never-played completeness rows; the putting
  0.01 shifts are inter-publication noise (ESC book vs 2011 paper — both Broadie); 90 ft is never
  a real input. The decision-relevant range (100–250 yd approaches, greenside, putts < 30 ft) was
  already correct. Net: verification confirmed the keystone values that matter.
- **Residual risk:** model-checked against recalled tables, not a PDF. Immaterial given the above,
  but flagged for the record.
- **Minor:** file header line 3 still opens citing *Every Shot Counts*; the D19 note cites the
  2011 papers. Consistent (Table 9 is reprinted in ESC); left as-is.

## Process deviation
The executing session did not commit or write this report per the reporting protocol; the reviewer
committed the change as T1 and authored this report after direct verification.
