[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ArulAdiSanjaya/site-generator-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ArulAdiSanjaya/site-generator-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-fast

A faster drop-in for **makefun-site 1.0.0** — [Build a static site faster, 22 November 2026](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`solve.js` exports `run(input)`, which returns exactly the answer makefun-site 1.0.0 returns for every input: the output tree (each page's `index.html`, the index and tag pages, `build-report.txt`, and each static file), byte for byte. `main.ts` is the harness driver (copied verbatim from the competition kit's house baseline).

## How it is faster

The reference build is re-implemented with the same observable behaviour, but without its per-character regex work, token arrays, and closure-per-loop-item rendering:

- **Markdown**: blocks are rendered streaming, line by line, with no lexer token array; inline markup is scanned with a single native regex pass that also handles HTML escaping, so plain text between marks is copied verbatim.
- **Front matter**: parsed by scanning line boundaries instead of splitting and regex-matching every line.
- **Slugs**: cached per case (titles, tags, and headings repeat a lot); pure-ASCII inputs skip the NFKD normalisation.
- **Templates**: parsed once per case into a compact node tree and rendered with a merged scope object — a `for` loop binds its variable (and `loop`) in place, saving and restoring the previous value, instead of allocating a scope object and closure per item.
- **Reading time**: each source's word count is computed once and memoised.

Everything is deterministic: no clock, no randomness, no environment reads, and nothing is carried from one case to the next (all caches live inside one `run()` call).

## Grade locally

From the unpacked competition kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## Layout

- `solve.js` — the fast drop-in (`run(input)`)
- `main.ts` — the harness driver
- `LICENSE` — MIT
