Analyze the release screenshot comparison report and produce a readiness assessment.

## Steps

1. Read `release-compare/comparison.json` to get the structured diff data.
2. Read `release-compare/index.html` to understand the full visual comparison (this is the detailed screenshot comparison report that humans should also review).
3. Read `release-compare/current-results.json` to see test pass/fail results for the current code. (Baseline failures are expected for new features and can be ignored.)
4. Run `git tag --list 'v*' --sort=-v:refname | head -n 1` to find the last release tag.
5. Run `git log <last-tag>..HEAD --oneline` to get the list of commits since the last release.
6. For each changed screenshot, analyze whether the change looks intentional (correlates with a commit/feature) or unintentional (possible regression).
7. For each test assertion failure, determine if it reflects a desired behavioral change or a bug.
8. Write `release-compare/readiness-report.html` — an HTML report with:
   - A prominent link to the full screenshot comparison report (`index.html`) so reviewers can inspect every visual change in detail
   - Overall release readiness verdict (Ready / Needs Review / Not Ready)
   - Each screenshot change categorized as intentional/unintentional with reasoning
   - Each assertion failure categorized as expected/bug with reasoning
   - Recommendations for what to address before release
   - The commit log between the two versions

Style the HTML similarly to the comparison report (dark theme, clean layout). Make the link to the full comparison report very visible at the top of the page.

## Linking to individual screenshots

The comparison report (`index.html`) has per-screenshot anchor IDs on every card. The format is:

```
#shot-<key-with-slashes-and-dots-replaced-by-hyphens>
```

For example, `pr-description-comments/01-review-tab-pr-header.png` becomes `#shot-pr-description-comments-01-review-tab-pr-header-png`.

**Every screenshot filename mentioned in the readiness report MUST be a clickable link** to the corresponding card in `index.html`. Use `<a href="index.html#shot-...">filename.png</a>` so the reviewer can jump straight to the side-by-side comparison. Never mention a screenshot filename as plain text.

## Important

- Be conservative: if you're unsure whether a change is intentional, flag it for review.
- Group changes by feature walkthrough for easier reading.
- If there are no changes at all, say so clearly and mark as ready.
