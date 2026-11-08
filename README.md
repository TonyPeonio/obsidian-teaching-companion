# Teaching Companion

An [Obsidian](https://obsidian.md) plugin for teaching assistants and instructors who grade with a
rubric. **Student work never leaves your machine.** Submissions are read from your vault and graded
by a local model through [Ollama](https://ollama.com): for every rubric criterion you get a proposed
score, a one-sentence justification and verbatim quotes from the submission as evidence, in a draft
note you finish by typing your own score. A grade book sums up the folder. No cloud model ever sees
a student's name or words, which is the condition most institutions put on using AI in grading at all.

Teaching Companion is part of the Companion suite of local-first Obsidian plugins by Tony Peonio for
students and researchers: your machine does the work, every change is a diff you approve, and the
numbers are published. The others are Local Vault Agent (local Ollama agent that searches, compiles,
edits notes), Lecture Companion (live local lecture transcription, Canvas slides, Ollama summaries),
Canvas Companion (Canvas LMS assignments, grades and announcements as notes), Exam Companion
(day-by-day study plan, daily quizzes and flashcards), Paper Companion (Zotero search by meaning,
page-cited reading notes), Research Log Companion (append-only lab notebook with git, parameters,
data hashes), Job Hunt Companion (job applications as notes, resume tailoring, interview questions),
Fellowship Companion (grants and fellowships: deadlines, materials, letters, eligibility), Code
Companion (commits in the daily note, weekly report, TODOs) and Branching Table of Contents
(parent/child properties as a rooted family tree). All at
[github.com/TonyPeonio](https://github.com/TonyPeonio).

- **Your rubric, as a note.** A markdown table with criteria, points and descriptions; optional
  score levels. Nothing to configure in a form.
- **Proposals, not grades.** Every score the model suggests sits next to an empty *Your score*
  cell and a banner saying so. The grade book counts a submission as final only when you have
  filled in every row.
- **Evidence you can check.** Quotes must appear verbatim in the submission (whitespace and case
  aside); the ones that do not are dropped and counted in the note, so you can see how reliable
  the model was on that submission.
- **Draft comments to the student**, written from the justification, kind and specific, never
  mentioning a score.
- **A grade book** with per-criterion averages, a distribution by 10% band and the most-missed
  criteria, deterministic from the notes.
- Free and open source, MIT licensed. No accounts, no API keys, no telemetry.

## Requirements

1. [Ollama](https://ollama.com) running locally (the default URL is `http://localhost:11434`).
   Keep it on the machine that holds the submissions; the point is that student work stays there.
2. A chat model: `ollama pull qwen3.5:9b` (default; fits a 12 GB GPU). A larger model grades more
   consistently; any Ollama chat model works.
3. Desktop Obsidian 1.7.2 or later (the plugin reads PDF files from the vault).

## Usage

1. **New rubric** writes a template to `Teaching/Rubrics/<name>.md`. Replace the example criteria.
2. Put the submissions in a vault folder, as notes, `.txt` or `.pdf` files (one per student).
3. **Grade a submission** (ribbon icon or command): pick the rubric and a file, or paste text. The
   draft opens at `Teaching/Grading/<rubric>/<submission>.md`.
4. Or **Grade a folder**: every file in the folder gets a note; a progress window shows each total
   and has a Cancel button. Submissions that already have a note are skipped unless you tick
   *Re-grade existing*; any *Your score* you typed is carried over.
5. Read the evidence, fill in *Your score* in each note's table, edit the comments.
6. **Grade book** rebuilds `Teaching/Grading/<rubric>/Grade book.md` from the notes.
7. **Rubric check**, with a rubric note open, writes deterministic checks and the model's
   suggestions under `## Suggestions` in that note.

### Rubric format

A rubric is a note under the rubrics folder with a table. Rows with an empty *Criterion* cell are
score levels for the criterion above them; a `total:` property or a *Total* row states the
expected total so the plugin can check the points add up.

```markdown
---
total: 20
---
# Essay rubric

| Criterion | Points | Description |
|---|---|---|
| Thesis | 5 | States a clear, arguable thesis early and keeps to it. |
| | 5 | Excellent: the thesis is specific, arguable and guides the whole piece. |
| | 3 | Adequate: a thesis is present but broad or drifts. |
| | 1 | Weak: no identifiable thesis. |
| Evidence | 10 | Supports each claim with relevant, cited evidence and explains the link. |
| Mechanics | 5 | Grammar, spelling and formatting do not get in the way of reading. |
| **Total** | 20 | |
```

The other accepted layout is one small table per criterion under a heading that names it:

```markdown
### Method
| Level | Points | Description |
|---|---|---|
| Excellent | 5 | Every step is reproducible from the text. |
| Adequate | 3 | Most steps are given; some quantities are missing. |
```

Header names are matched loosely (*Criteria*, *Pts*, *What to look for* all work), and points may
read `5 pts` or `0–5`.

### Commands

| Command | What it does |
|---|---|
| New rubric | Writes a rubric template note to the rubrics folder |
| Grade a submission | Grades one note, `.txt`, `.pdf` or pasted text against a rubric; writes the draft grading note |
| Grade a folder | Grades every submission file in a folder, with progress and Cancel; then rebuilds the grade book |
| Grade book | Rebuilds `<grading folder>/<rubric>/Grade book.md` from the grading notes |
| Rubric check | Flags missing descriptions and points that do not add up; asks the model about overlap; writes `## Suggestions` |

### How it works

**Text.** Notes and `.txt` files are read as they are (a note's frontmatter is dropped). PDFs go
through the pdf.js that ships with Obsidian, page by page, so evidence can cite `p. N`; plain text
is cited by paragraph (`¶ N`). A scanned PDF without a text layer is reported, not guessed at.

**Prompt.** One call carries the rubric criteria (with their levels), the submission between
markers, and a strict JSON schema: per criterion a `score`, a one-sentence `justification` and
`evidence` quotes with a location. The model runs at temperature 0.1 in JSON mode with thinking
off. When the submission and all criteria fit the context window (3.2 characters per token, 320
tokens reserved per criterion for the reply), it is one call; otherwise the criteria are split
into the fewest groups that fit, each with the full text. A submission longer than the window
minus one criterion is cut and the note says so.

**Validation.** Scores are coerced to numbers and clamped to `0…max`, with a flag when that
changed anything. Quotes are kept only if they occur in the submission after normalising
whitespace, case, curly quotes and dashes; at most three per criterion; the dropped count is in
the note. Criteria the model skipped are listed as not scored and left blank, never filled in.
Criteria the model invented are ignored.

**Grading note.** Frontmatter `rubric`, `submission`, `source`, `total_proposed`, `total_max`,
`status: draft`, `graded`, `model`; the banner; a *Scores* table (criterion, proposed, max, your
score, justification); *Evidence* with the quotes and locations; *Comments*, one draft per
criterion built from the justification with any score talk removed (the *detailed* tone adds the
strongest quote and the next rubric level); and *Grading notes* with the call count, dropped
quotes, truncation and clamps. Re-grading a submission keeps the *Your score* values you typed.

**Grade book.** Reads every grading note in the rubric's folder. A note is *final* when every
*Your score* is filled; its final total is used, otherwise the proposed one. Per-criterion
averages (proposed, final and effective percentage), a distribution line (count per 10% band,
90–100% at the top) and the three criteria with the lowest average percentage. Sorted by
submission name, so the same notes always produce the same note.

**Rubric check.** Deterministic: no criteria, no points, no description, duplicate names, a level
above the maximum, points that do not match the stated total. Then one model call asking for at
most six one-sentence suggestions about overlap and unobservable descriptions.

`npm run grade:live` runs the grading path against a real Ollama model with a three-criterion
rubric and two synthetic submissions, and checks that both parse and the weak one scores lower
(see `scripts/grade-live.ts`).

## Settings

- **Rubrics folder** (`Teaching/Rubrics`) and **grading folder** (`Teaching/Grading`). The plugin
  writes only under the grading folder, plus `## Suggestions` in a rubric note you check.
- **Ollama URL** and **chat model**, with a connection test.
- **Context size** (`num_ctx`, 16384 by default). Raise it for long submissions.
- **Comments tone**: *brief* (one sentence) or *detailed* (adds a quote and the next level).
- **Quote the submission in comments**: on by default.

## Privacy and network use

The plugin talks only to the Ollama URL you set, and only when you run *Grade a submission*,
*Grade a folder* or *Rubric check*. Submissions are read from the vault folder you choose and the
grading notes are written under the grading folder. Nothing else is read, sent or stored. No
telemetry, no accounts.

Local does not mean infallible: a 9B model misreads, over-rewards confident prose and sometimes
quotes what it wishes the student had written. The plugin shows you the dropped quotes and the
clamped scores so you can tell when to trust a note less, and every score stays a proposal until
you type yours.

## Development

```bash
npm install
npm run dev        # watch build → main.js
npm test           # unit tests (vitest), no Ollama needed
npm run build      # type-check + Obsidian review lint + production bundle
npm run grade:live # two real model calls against a local Ollama
```

To release: bump `version` in `manifest.json` and `package.json`, add the version to
`versions.json`, write `release-notes/<version>.md`, commit, then push a tag named exactly
`<version>`. The release workflow builds, tests, attests and publishes the GitHub release.

`src/core/` (rubric parser, grading prompt and validator, grading note, comments, grade book,
rubric check, submission loading, Ollama client, pdf.js wrapper) has no Obsidian dependency and
is tested against an in-memory vault and fake model replies; `src/main.ts`, the modals and the
settings tab are the thin Obsidian layer.

## License

MIT
