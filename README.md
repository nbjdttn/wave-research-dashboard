# Wave Research

A personal research briefing that lives on GitHub Pages and is built for a phone: add it to the
home screen and it behaves like an app (pull down to refresh, swipe, no zooming about).

![Today, Funding and Profile screens](docs/screens.jpg)

| Screen | What it shows |
| --- | --- |
| **Today** | The front page: new papers close to your work, new papers citing you, funding calls and the next deadlines. |
| **Papers** | A daily feed of *new* work (not a literature review), ranked against your own publications, plus a live search of all journals scored the same way. |
| **Funding** | A short list of opportunities that pass **both** tests — your research topic *and* your career stage — each with its deadline, a checklist of what to submit, an effort estimate and a "start by" date. Recurring calls that are not open yet appear under *Prepare ahead*. |
| **Profile** | Your record: citations, h-index, trends, themes, journals, collaborators and the full list. **Citations** shows who is citing you (independent groups, co-authors, yourself) by year, month, journal, country and institution. **Peers** sets your growth since the PhD beside researchers at a similar stage in the same field at leading universities — swipe a person out of the group, or in from the bench. |

Every paper has a **Send to Claude** button and every funding call a **Plan it with Claude** button:
they open a new Claude Code session on this repository with the request typed in, ready to send.

Live site: **https://nbjdttn.github.io/wave-research-dashboard/**

Tap the sliders icon (top right) to choose one of eight colour palettes — Ocean, Coast, Midnight, Kelp,
Coral, Slate, Paper, Graphite — each in light and dark.

## Set-up — two steps, both doable from a phone

**1. Turn on GitHub Pages**

Repository → **Settings → Pages → Build and deployment**: Source **Deploy from a branch**, pick the
branch that holds this code and the folder **/ (root)**, then **Save**. The site is live about a minute later.

**2. Add your Claude API key** (this is what keeps the funding list reviewed every day)

Repository → **Settings → Secrets and variables → Actions → New repository secret**

- Name: `ANTHROPIC_API_KEY`
- Value: a key from the [Claude Console](https://platform.claude.com/)

The key stays inside GitHub's secret store. It is used only by the scheduled job and is never part of
the web page. Then open **Actions → Update data → Run workflow** once, or simply wait for the next morning.

That is all. To install it like an app, open the site on your phone and choose *Add to Home Screen*.

### Optional settings

| Where | Name | Purpose |
| --- | --- | --- |
| Actions **variable** | `CLAUDE_MODEL` | Model used for the reviews. Default `claude-opus-5-5`. Set `claude-sonnet-5-5` or `claude-haiku-5-5` to spend less. |
| Actions **secret** | `S2_API_KEY` | A free [Semantic Scholar](https://www.semanticscholar.org/product/api) key makes the recommendations and "citing you" steps dependable (without one they share a public rate limit and are sometimes skipped). |
| Actions **secret** | `OPENALEX_API_KEY` | A free [OpenAlex](https://openalex.org/) key adds a fourth source to the papers feed. |

## How the daily update works

`.github/workflows/update.yml` runs every day at 05:17 UTC, whenever `config/` changes, and on demand. It runs
`python scripts/update.py`, commits the refreshed files in `data/`, and Pages republishes the site.

```
profile   Google Scholar snapshot (when reachable) ─┐
          ORCID · Crossref · OpenAlex (daily) ──────┴─► data/profile.json   (metrics, publications, history)

citations Semantic Scholar: every paper citing yours ─► who they are (independent, co-author, self),
          OpenAlex: where they work ─► data/citations.json   (by year, journal, country, institution)

papers    Semantic Scholar recommendations (seeded with your papers)
          arXiv · Crossref · papers citing you ─► scored against your own work ─► data/papers.json

peers     authors of the papers around your work, seen at a leading university (OpenAlex, free)
          ─► same field, PhD within a few years of yours ─► data/peers.json   (yearly citations and papers)

grants    UKRI Funding Finder (live calls + two years of past calls, to spot repeats)
          EU Funding & Tenders portal · watch-list of funder schemes (config/schemes.json)
             │  1. screen   out-of-field councils and invite-only calls dropped; Claude triages the rest
             │  2. read     full text of each shortlisted call
             │  3. assess   Claude: topic fit · career-stage fit · eligibility · deadline ·
             │              what to submit · effort · does it repeat, and when
             ▼  4. select   only calls passing both the topic and the career-stage test
          data/grants.json
```

**Alerts.** When a strong new call appears, or a selected call comes within a fortnight of its deadline,
the job adds one short comment to an issue called *Funding alerts* in this repository. GitHub then
notifies you — by email, and on your phone if you use the GitHub app. Switch it off or tune it with
`alerts`, `alert_min_fit` and `alert_days_before` under `[grants]`.

Every source is optional: if one is down, the previous data for it is kept and the run still succeeds.
Results are cached by content, so Claude is only asked about calls that are **new or have changed**.

### What Claude costs

The reviews use the Messages API with structured outputs. A full read of one call is roughly
$0.05–0.10 with the default model. The site ships with the current list already reviewed, so a
typical day needs only a handful of calls — expect a few dollars a month. Two guards keep it bounded:
`max_calls_per_run` in `config/researcher.toml` (default 40), and the cache described above. The run
summary on the Actions page shows the number of calls and the estimated cost each day.

Without a key the site still works: the publication record and papers feed update as normal, the
existing funding reviews are kept, and new calls are listed under *Awaiting review*.

## Make it yours

Everything the pipeline knows about you is in **`config/researcher.toml`**:

- **`[career]`** — the career stage Claude reasons about. `phd_award_year` matters: several
  fellowships hinge on years since the PhD. `priorities` and `not_wanted` are passed to Claude word for word.
- **`[interests]`** — weighted phrases that rank papers (`core`, `methods`) and look-alike topics to push down (`avoid`).
- **`[papers]`** / **`[grants]`** — time windows, search phrases, thresholds.
- **`[peers]`** — who counts as a peer: the PhD window, topic overlap, the list of leading universities,
  people to always include or leave out, and corrections to PhD years (those marked `~` are estimates).
- **`[claude]`** — model, effort, spending guard, how often scheme pages are re-read, and
  `reassess_on_profile_change`: after you edit your profile, re-review only the calls whose eligibility
  was uncertain (`"uncertain"`, the default), every call (`"all"`) or none (`"none"`).

To add a palette of your own, copy a block in `assets/js/palettes.js` and change the colours.

`config/schemes.json` is the watch-list of recurring schemes that have no machine-readable feed
(Royal Society, Leverhulme, Royal Academy of Engineering, ERC, …). Add or remove entries freely.

Saving a change to either file (the GitHub app or website editor is fine) starts an update straight away.

## The daily agent

Besides the scripted job, a scheduled Claude Code session can look at things a script cannot: funder
pages that block scripts, new schemes with no feed, a fresh Google Scholar reading, peers' real PhD
years. It follows `CLAUDE.md`, writes a short briefing (`data/briefing.json`, shown at the top of
*Today*) and pushes to the published branch. It uses your Claude plan each time it runs; pause, change
or delete it under scheduled tasks at claude.ai/code.

## Good to know

- **It is public.** A public repository means the site and the files in `data/` are public, including
  the fit notes written about each funding call. The page asks search engines not to index it, but
  anyone with the link can read it. Reading list, shortlist and ticked checklist items are stored
  only in the browser of the device you use.
- **The peer comparison names real people** using public OpenAlex figures. Set `show_names = false` under
  `[peers]` to show "Peer 1, Peer 2 …" instead; the names are then left out of the data file as well.
- **Citation counts differ by source.** Google Scholar counts more than Semantic Scholar can trace
  (theses, reports, some conference papers), so the *Citations* tab says how many it found.
- **Dates marked `~` are estimates** inferred from earlier rounds. Always confirm on the funder's page —
  each card links to it.
- **Google Scholar figures are a dated snapshot.** Scholar has no API and turns away requests from
  GitHub's servers, so the daily job cannot refresh them. The headline numbers therefore show the
  date they were read, and the page also shows OpenAlex figures, which do update every day (they run
  a little lower than Scholar's). New papers still arrive daily through ORCID. To refresh the Scholar
  snapshot, run `python scripts/update.py profile` from a personal computer and push `data/`, or ask
  a Claude Code session to do it.
- **Some funder sites block scripts** (Leverhulme, ICE). With a Claude key those pages are looked up
  with Claude's web search tool about once a fortnight instead.
- GitHub pauses scheduled workflows in repositories with no activity for 60 days; the daily data
  commit counts as activity, so this one keeps itself awake.

## Run it locally

```bash
pip install -r requirements.txt
python scripts/update.py            # or: profile | citations | papers | peers | grants
python -m http.server 8000          # then open http://localhost:8000
```

Set `ANTHROPIC_API_KEY` in your shell to include the Claude reviews. `scripts/seed_tools.py` can
export the same briefs for review by hand and import the answers.

## Layout

```
index.html, sw.js, manifest.webmanifest   the app shell (no build step, no dependencies)
assets/css, assets/js                     interface: views, charts, similarity scoring
assets/fonts                              Inter (SIL Open Font License)
config/                                   researcher.toml, schemes.json
data/                                     generated JSON (+ data/cache, the pipeline's memory)
scripts/update.py, scripts/wave/          the data pipeline (Python)
.github/workflows/update.yml              the daily job
.github/workflows/pages.yml               publishes the site if Pages is set to "GitHub Actions"
```
