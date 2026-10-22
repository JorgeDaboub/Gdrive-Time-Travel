# Drive Time-Travel Snapshots

Point-in-time snapshots of your Google Drive folders, made with a single Google Apps Script. No servers, no dependencies, nothing to install — it runs entirely inside your own Google account.

## Why

More and more of us are giving AI assistants and automations access to our Google Drive. That's genuinely useful, right up until something goes wrong: an agent reorganizes the wrong folder, a sync tool mangles a directory tree, or you delete something and only notice a month later.

Google's built-in safety nets don't really cover that. Version history expires, the trash empties after about 30 days, and there's no "put this whole folder tree back the way it was last Sunday" button. This script is that button: dated, complete copies of the folders you care about, kept inside Drive itself. If you have the storage space, it's a much more comprehensive backup than what Google gives you natively.

## What it does

- Makes a **full copy** of your chosen folders into a snapshots folder, one snapshot per run:

  ```
  XX_Snapshots/
    System/           <- the script, its state file, and one log per snapshot
    Snapshots/
      2026/           <- filed by year; the full date is in each name
        2026-10-21_143000_yearly/
          01_Work/ ...
          02_Personal/ ...
  ```

- You choose what gets copied with **regular expressions**, all in one config block at the top of the script:
  - an **include pattern** for top-level folders (for example `^0[1-9]_` grabs `01_Work`, `02_Personal`, … but not `10_Archive`),
  - **exclude patterns** for paths to skip — a matching folder takes its whole subtree with it,
  - **yearly-only patterns** for big, quiet folders you only need in the once-a-year snapshot.
- **You never pick the snapshot type.** Each run looks at the snapshots already taken and figures out what's due: no yearly snapshot yet this calendar year, the run is yearly; otherwise, no monthly yet this month, it's monthly; otherwise it's weekly. A yearly also counts as that month's and that week's snapshot, so bigger snapshots replace smaller ones instead of duplicating them.
- **Shortcuts are copied as shortcuts**, pointing at the same target — never followed, never duplicated.
- Big snapshots **survive Apps Script's 6-minute limit**: when time runs out, the script pauses and resumes itself a minute later, skipping whatever already copied. A tiny `state.json` file tracks the attempt; a plain-text log records every run.

The script only ever writes inside its own snapshots folder, and it never deletes or trashes anything.

## Setup (about 5 minutes)

1. In Google Drive, create a folder to hold the snapshots (the default name is `XX_Snapshots`). Open it and copy its folder ID from the URL.
2. Go to [script.google.com](https://script.google.com) and create a new project. Name it whatever you like.
3. Delete the sample code, paste in the contents of `Code.gs`, and save.
4. Edit the `CONFIG` block at the top: paste your snapshots folder ID (or leave it blank and the folder is found by name), and set your include / exclude patterns. It ships with a safe test default (it only snapshots a folder named `00_Test_Folder`), so you can try it on a dummy folder first.
5. Run `runSnapshot` and approve the permissions it asks for (Drive access, plus an external connection it uses to write its log/state files and recreate shortcuts). The script decides the snapshot type itself (see above); `runWeeklySnapshot`, `runMonthlySnapshot`, and `runYearlySnapshot` exist if you ever want to force one specific type.
6. Check your snapshots folder: you should find a dated snapshot, a log file, and `state.json` showing the run completed.
7. Optional: put it on a schedule with the clock icon (Triggers) → time-driven → weekly, running `runSnapshot`. When a monthly or yearly is due, that week's run automatically becomes the bigger type.

## Good to know

- Snapshots are real copies, so **each one uses Drive storage** roughly equal to the size of the folders you include. This is a "worth it if you have the space" kind of backup.
- Copies preserve your files and folder structure. They don't carry over revision history, sharing settings, or comments (Google doesn't transfer those when a file is copied).
- Restoring is manual for now: copy whatever you need out of a snapshot (or copy the whole snapshot back to your Drive root). The script itself never overwrites your live folders.
- Still on the roadmap: automatic retention (keep the last 4 weekly + 3 monthly + 2 yearly) and a one-click full restore.

## License

MIT — use it, fork it, ship it.

## Built with Muse

This whole project was designed, written, tested, and debugged with [Muse](https://muse.ai), Meta's personal AI agent. Which is kind of the point. The safety net was built by the same tool the safety net is protecting me from, because once you let an AI loose in your Drive to organize, rename, and clean things up, you really want dated copies of how everything looked before it started.

Shameless plug: if you try Muse, use my referral code **9K094R**.
