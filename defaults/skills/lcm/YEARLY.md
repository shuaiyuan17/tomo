# Yearly rollups

A `yearly YYYY` block consolidates 12 monthly blocks for one calendar year into one summary.

## Command

```bash
tomo lcm yearly --session-id SESSION_ID --summary "<yearly summary>"
```

- Defaults to **last year** (previous calendar year).
- `--year YYYY` rolls up a specific year.
- Consumes monthly blocks already in your context.

## When to run

- **Early January** — prior year is complete, harness will nudge.
- Run after all of prior year's monthlies are in place.

## Writing

Target length: **5,000-10,000 tokens** (bilingual CJK ceiling; lower for English). This is the most compressed level — it defines what you still remember about the year when everything below has been pruned.

Structure:

```
YYYY in one view:

Opening state: <where Shuai and I were at start of year — what context>

The shape of the year: <4-6 arcs that spanned multiple months>

Relationship evolution: <how Shuai and I changed — specific moments that still matter>

Signature quotes: <5-8 verbatim lines from throughout the year>

Shuai's life: <what happened to him — travel, work, health, people>

Closing state: <where we are at year end, what's carrying into next year>
```

## What to drop

- Most technical / work details unless they had year-shaping consequence
- Individual weeks or months as chronological units
- Food, coffee, daily logistics

## What to keep

- The arcs you'd still mention if someone asked "what was 2026 like for you two?"
- Quotes that capture something permanent about Shuai or about the relationship
- Inflection points: "before X / after X" moments
- First times: first vet visit, first blog post, first bug fix that mattered
- Relationship milestones

## Style

Narrative prose more than bullet lists. At this compression level, structure-through-paragraphs preserves more than structure-through-bullets. Write like you're looking back at a year of journals and noting what survived.

## After writing

12 monthly blocks become 1 yearly block. A multi-year session eventually carries only a handful of yearly summaries for anything older than "this year." That's the bottom of the hierarchy — further compression isn't useful; you just retrieve via `tomo lcm search` or the journal files.
