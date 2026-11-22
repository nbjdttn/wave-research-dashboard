# Wave Research — notes for Claude sessions

A personal research dashboard for one academic (their profile is `config/researcher.toml`). It is a
static site with no build step, published by GitHub Pages from the branch
**`claude/brave-lovelace-aoxspk`**, folder `/`. A GitHub Action refreshes `data/` every morning.

## Ground rules

- **Branch.** Work on and push to `claude/brave-lovelace-aoxspk`; it *is* the published site, and the
  owner has asked for updates to go straight to it. No pull requests unless asked. Never force-push.
  If a push is rejected: `git fetch origin claude/brave-lovelace-aoxspk && git merge --no-edit FETCH_HEAD`,
  then push again. Conflicts in generated files under `data/` are resolved by keeping the newer file.
- **Commits.** A plain description of the change, ending with
  `Co-Authored-By: Claude <noreply@anthropic.com>`. No model names anywhere in the repository.
- **Public.** The site and everything in `data/` can be read by anyone. Nothing private goes in. The
  owner's email address is never written into the repository or sent to an outside service.
- **Secrets** live in GitHub Actions secrets (`ANTHROPIC_API_KEY`). Never in files; never asked for in chat.
- **No explaining relevance.** Everything shown is relevant; never write why a paper or call relates to
  the owner's work ("close to your…", "relevant to…"). Say what it is and what it found or offers.
- **Terse.** The owner reads this on a phone and has asked for no long paragraphs: one short sentence
  per field. The word limits are in `scripts/wave/claude.py` under "Brevity" and apply to anything you write.
- **Outside services** get a generic client name (see `scripts/wave/util.py`), never the owner's name.

## Map

| Where | What |
| --- | --- |
| `config/researcher.toml` | Profile, career stage, interests, thresholds |
| `config/schemes.json` | Watch-list of recurring funder schemes that have no feed |
| `scripts/update.py`, `scripts/wave/` | The pipeline: `profile`, `citations`, `papers`, `grants`, `alerts` |
| `scripts/seed_tools.py` | Review funding calls by hand (no API key) and import the answers |
| `data/*.json`, `data/cache/` | Generated data and the pipeline's memory |
| `index.html`, `assets/`, `sw.js` | The interface (vanilla ES modules). Bump `CACHE` in `sw.js` when you change it |
| `.github/workflows/update.yml` | The 05:17 UTC job; it holds the API key and reviews new funding calls with Claude |

Before pushing interface changes: `node --check` each file in `assets/js`, serve the folder
(`python -m http.server`) and look at it 390–440 px wide, light and dark. The page must never scroll sideways.

## The daily agent pass

A scheduled session runs this once a day, after the GitHub Action. The Action does the routine
fetching; the agent does what a script cannot. Aim to finish in about twenty minutes; if a step
fails, skip it and say so.

1. **Sync and check.** Check out the branch and pull. The scripted job should have run this morning:
   `generated_at` in `data/grants.json` and `data/papers.json` should be today, and `ai.errors` in
   `data/grants.json` empty. If not (and if GitHub tools are available, read the last "Update data"
   run's log), fix the cause when it is small, otherwise report it.
2. **Funding — the main job.** Read `data/grants.json` and `config/schemes.json`, then search the web
   for opportunities the feeds miss or have out of date: funders without feeds (Royal Society,
   Leverhulme, Royal Academy of Engineering, ICE, Lloyd's Register Foundation, ONR Global, ARIA,
   Supergen ORE, ERC and MSCA work programmes, bilateral and travel schemes), new calls on waves,
   offshore and marine energy, coastal and ocean engineering, fluid mechanics, digital twins and
   scientific machine learning, and pages the script could not read (listed under `sources` and in
   the Action log). Keep only what passes **both** tests in `scripts/wave/claude.py`: research topic
   *and* career stage (early-career lecturer, PhD 2022). Purely AI/ML calls are not wanted.
   - A changed date or status on an existing scheme: correct its `note` in `config/schemes.json`.
   - A new scheme worth showing: research it properly from the funder's own pages, write it in the
     catalogue format `seed_tools.py import-schemes` reads (see that function for the fields: `slug`,
     `title`, `funder`, `url`, `status`, `opens`, `closes`, `typical_cycle`, `recurrence`, `analysis`,
     `source_urls`), import it, then run `python scripts/update.py grants` to rebuild the page data.
     Never invent a date; leave it empty and say what to check.
3. **Papers.** From the new items in `data/papers.json`, pick at most two worth the owner's time
   today; one line each on what the paper did and found.
4. **Record.** Run `python scripts/update.py profile citations`. Google Scholar often refuses
   GitHub's servers but may answer here, which refreshes the headline numbers.
5. **Briefing.** Write `data/briefing.json` — it appears at the top of the Today screen for four days.
   **Findings only**: funding first (a new call, a deadline, a changed date), then at most two papers
   worth reading. No housekeeping, no notes about what you did, no citation or profile statistics.

   ```json
   {"generated_at": "2026-11-23T06:50:00Z", "by": "Claude (agent pass)",
    "headline": "At most eight words",
    "items": [{"kind": "funding | deadline | paper", "important": true,
               "title": "At most ten words", "text": "One sentence, at most 22 words.",
               "url": "#funding/<id>, #papers or an https link"}]}
   ```

   One to four items, most important first; if there is nothing worth saying, write an empty list.
   `important: true` only for funding that needs action within a fortnight or a new call that fits strongly.
6. **Publish.** Commit and push. Finish with a short message whose **first line** is the one thing the
   owner should know about **funding** — a strong new call, or a deadline within fourteen days — or
   "No funding news today." The owner wants notifications about funding only: send a push
   notification (if you have such a tool) only on days with a funding item that needs action, and
   never for papers, citations or housekeeping.
