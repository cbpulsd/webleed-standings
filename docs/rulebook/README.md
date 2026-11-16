# Season V rulebook: preservation copies

This folder keeps a fixed copy of the Season V Official Rulebook, so there is a record of the
rules as they stood when a ruling was made, and a baseline to compare against if the rules change.

**The official rulebook is the original document:**
[Season-V-Official-Rulebook-2026.docx (Google Drive)](https://docs.google.com/document/d/1rXPErabnHDVpiHNYHI6v77g4lR_J73vU/edit).
If a copy here and the original disagree, the original wins.

| Copy | Captured | Notes |
|---|---|---|
| [season-v-official-rulebook.md](season-v-official-rulebook.md) | 2026-11-16, 6:05 PM ET (Week 3) | First copy. Text unchanged, converted to Markdown. |

## Keeping it up to date

- Don't edit a copy's rulebook text. Leave each copy as captured.
- When the original changes, add a new copy named with the date (for example
  `season-v-official-rulebook-2026-12-01.md`), add a row to the table above, and say in the
  commit what changed. `git diff --no-index` between two copies shows the exact wording changes.
- Rulings that the site applies in code (such as a tie decision in `src/config.js`) should cite
  the section they rely on.
