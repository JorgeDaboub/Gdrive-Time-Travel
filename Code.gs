/**
 * Drive Time-Travel Snapshots — PROTOTYPE v0.12 (CONFIG-DRIVEN)
 * =============================================================
 * Point-in-time snapshots of selected Google Drive folders: one full
 * server-side copy per run, stored under a snapshots folder like this:
 *
 *   XX_Snapshots/
 *     System/                        <- the machinery itself
 *       Snapshot Driver              <- this Apps Script project
 *       Code.gs                      <- a readable copy of this source
 *       state.json                   <- THE state file (see below)
 *       Logs/                        <- flat: one .log.txt per attempt
 *     Snapshots/                     <- the actual backups, nothing else
 *       2026/                        <- organized by YEAR only, flat inside
 *         2026-10-21_143000_test/      (full date is in the name)
 *           01_Career/ ...  02_Personal/ ...
 *
 * WHAT GETS SNAPSHOTTED is entirely driven by the CONFIG block below —
 * no folder names are hardcoded in the engine. The rules, in order:
 *
 *   1. INCLUDE — walk the top level of My Drive. Every top-level FOLDER
 *      whose name matches `includeRootPattern` (a regular expression)
 *      becomes a snapshot root and is copied recursively, in full.
 *      Example: '^0[1-9]_' selects 01_Career, 02_Personal, ... but not
 *      10_Heavy Files or 11_Projects.
 *   2. EXCLUDE — while copying, every file and folder is checked by its
 *      path (relative to My Drive root, e.g. '03_Finance/2024 Taxes'
 *      or '01_Career/Resumes/old.pdf') against `excludePatterns`. A
 *      match is skipped — and when a FOLDER matches, its entire subtree
 *      is skipped with it. Excludes always win over the include rule.
 *      Root folders themselves are checked too (path = their name).
 *   3. YEARLY-ONLY — `yearlyOnlyPatterns` work exactly like excludes,
 *      except they only apply to non-yearly runs: weekly and monthly
 *      snapshots skip those paths, yearly snapshots include them. Use
 *      for big, rarely-changing folders.
 *
 *   Patterns are partial matches (RegExp.test): 'Archive' matches any
 *   path containing "Archive"; anchor with ^ and $ for exact matches.
 *   Invalid patterns abort the run with a clear error before anything
 *   is copied.
 *
 * SHORTCUTS are copied AS shortcuts: a new shortcut in the snapshot,
 * same name, pointing at the SAME target. The target is never followed
 * or copied.
 *
 * STATE — deliberately as simple as it gets:
 *   One small JSON file, `System/state.json`:
 *     { "inProgress": { ...one attempt... } or null,
 *       "lastCompleted": { ... } or null }
 *   Starting is a best-effort check of that file: inProgress set means
 *   resume that attempt; null means start a new one. Human-speed use
 *   (a weekly trigger, an occasional manual run) is the threat model.
 *
 * HOW RESUME WORKS WITHOUT A SAVED QUEUE:
 *   There is no per-file progress list. The copy walk skips what is
 *   already in the snapshot (counted by name in each folder), so
 *   re-walking an interrupted attempt copies only the missing remainder.
 *   A copied file is atomic — already there means done. On top of that,
 *   the attempt records every folder whose subtree has been FULLY
 *   walked (`doneFolders` in state.json), and resumes prune those
 *   subtrees on sight instead of re-listing them — without this, a big
 *   snapshot spends most of each resumed segment re-walking what it
 *   already copied, and progress crawls (observed live, 2026-10-21).
 *
 * WHICH TYPE RUNS — the script figures it out:
 *   You never pick a type for a normal run. runSnapshot() looks at the
 *   COMPLETE snapshots already in Snapshots/<year>/ (the folders are
 *   the record: name encodes date + type) and applies the coverage
 *   rules: no yearly-scope snapshot this calendar year -> this run is
 *   YEARLY; else no monthly-scope snapshot this month -> MONTHLY; else
 *   WEEKLY. A yearly also satisfies its month and week, a monthly its
 *   week; satisfaction flows downward only. Explicit override
 *   functions (runYearlySnapshot etc.) exist for special cases.
 *
 * IDEMPOTENCY:
 *   Manual runs are FORCE runs: one always starts (with the type
 *   above) unless a snapshot is already in progress, in which case it
 *   is resumed instead. The future scheduled entry point adds the
 *   "skip if this week's snapshot is already satisfied" behaviour.
 *
 * Safety:
 *   - Everything written goes inside the snapshots folder (found by ID
 *     if `snapshotsFolderId` is set, name-checked either way).
 *   - Nothing is ever deleted or trashed by this script.
 *   - No schedule yet: nothing runs unless you run it.
 */

// ============================================================ USER CONFIG
// Everything a user needs to set lives here. The engine below reads
// only these values.
var CONFIG = {
  // --- Where snapshots are stored -------------------------------------
  // Name of the top-level folder that holds the whole snapshot system.
  snapshotsFolderName: 'XX_Snapshots',
  // Optional but recommended: that folder's Drive ID (open the folder,
  // the ID is in the URL). If set, the script uses it and name-checks
  // it; if left '', the folder is found — or created — by name.
  snapshotsFolderId: '',

  // --- What gets snapshotted ------------------------------------------
  // 1) INCLUDE: regex tested against top-level folder NAMES in My Drive.
  //    Production example: '^0[1-9]_'  (01_... through 09_...)
  //    The value below is the SAFE test default: only the dummy folder.
  includeRootPattern: '^00_Test_Folder$',

  // 2) EXCLUDE: regexes tested against each item's path (see header).
  //    A matching file is skipped; a matching folder prunes its subtree.
  //    Example: ['^05_Archive(/|$)', 'scratch']
  excludePatterns: [],

  // 3) YEARLY-ONLY: same matching as EXCLUDE, but only skipped on
  //    weekly/monthly runs; yearly runs include these paths.
  //    Example: ['^Archive/Old School Records(/|$)']
  yearlyOnlyPatterns: [],

  // --- Layout inside the snapshots folder (rarely changed) ------------
  systemFolderName: 'System',      // machinery: this project, state, logs
  backupsFolderName: 'Snapshots',  // the backups themselves
  logsFolderName: 'Logs',          // inside System, flat
  stateFileName: 'state.json',     // inside System

  // --- Run behaviour ----------------------------------------------------
  timezone: 'America/Los_Angeles',
  timeBudgetMs: 4.5 * 60 * 1000  // stop copying at 4.5 min, resume later
};

// ------------------------------------------------------------ ENTRY POINT
/**
 * Run THIS function in the Apps Script editor to take a snapshot.
 * You don't pick the type: the script checks which snapshots already
 * exist for this year / month / week and runs the largest type that's
 * still due (yearly, else monthly, else weekly — see header). First
 * run asks for Drive authorization, and for permission to connect to
 * an external service — that's how this script writes state.json /
 * log files and recreates shortcuts.
 */
function runSnapshot() {
  runSnapshot_(null);  // null = figure out the type automatically
}

/** Same as runSnapshot() — the historical name, kept as an alias. */
function runTestSnapshot() {
  runSnapshot_(null);
}

/** Resume-trigger target. Deliberately a DEDICATED handler name: the
 *  engine deletes/recreates resume triggers by handler, so a future
 *  weekly trigger (which will call runSnapshot directly) is never
 *  mistaken for one. Not meant to be run by hand. */
function resumeSnapshot_() {
  runSnapshot_(null);
}

/** Explicit overrides, for when you want one specific scope regardless
 *  of what's due. A yearly includes yearlyOnlyPatterns; weekly and
 *  monthly skip them. */
function runWeeklySnapshot() { runSnapshot_('weekly'); }
function runMonthlySnapshot() { runSnapshot_('monthly'); }
function runYearlySnapshot() { runSnapshot_('yearly'); }

/** Shared runner. runType null means auto (decided from the snapshots
 *  already on disk); an explicit type forces that scope. A resumed
 *  attempt always keeps the type it started with. */
function runSnapshot_(runType) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('Another run is executing right now — doing nothing.');
    // Self-heal: if this firing was a resume trigger and an attempt is
    // in progress, make sure a fresh resume trigger exists — otherwise
    // one lock collision (e.g. with a long segment) would silently end
    // the resume chain and stall the snapshot until a human notices.
    try {
      var xxL = getSnapshotsRoot_();
      var sysL = getOrCreateChildFolder_(xxL, CONFIG.systemFolderName);
      var stL = loadState_(sysL);
      if (stL.data.inProgress) {
        scheduleResume_();
        Logger.log('An attempt is in progress — resume trigger re-scheduled.');
      }
    } catch (ignored) { /* best effort only */ }
    return;
  }
  try {
    // Compile (and thereby validate) all patterns BEFORE any copying.
    var rules = {
      includeRe: compilePattern_(CONFIG.includeRootPattern, 'includeRootPattern'),
      excludeRes: compilePatterns_(CONFIG.excludePatterns, 'excludePatterns'),
      yearlyOnlyRes: compilePatterns_(CONFIG.yearlyOnlyPatterns, 'yearlyOnlyPatterns')
    };

    var xx = getSnapshotsRoot_();
    var systemFolder = getOrCreateChildFolder_(xx, CONFIG.systemFolderName);
    var state = loadState_(systemFolder);

    var attempt;
    if (state.data.inProgress) {
      attempt = state.data.inProgress;  // <- the simple check: it's there, resume it
      addLog_(attempt, 'Resuming in-progress snapshot.');
    } else {
      var newType = runType || determineRunType_(xx);
      attempt = startAttempt_(xx, systemFolder, newType, rules);
      // Record the attempt in state.json IMMEDIATELY, before copying
      // starts — otherwise state.json would show nothing in progress
      // until the first pause, and a hard crash in that first segment
      // would leave the half-made snapshot orphaned and forgotten.
      state.data.inProgress = attempt;
      if (!saveState_(state)) {
        throw new Error('state.json could not be saved — aborting before any copying. Check Drive connectivity/quota, then run again.');
      }
    }

    // Attempts started by older versions may lack the newer fields.
    if (!attempt.doneFolders) attempt.doneFolders = {};
    if (attempt.counts.doneSkipped === undefined) attempt.counts.doneSkipped = 0;
    if (attempt.counts.copyFailures === undefined) attempt.counts.copyFailures = 0;

    // A resumed attempt keeps the rules it STARTED with (they're stored
    // in the attempt): editing CONFIG mid-attempt must not change the
    // rules for the back half of a snapshot.
    var walkRules = rules;
    if (attempt.rules) {
      walkRules = {
        includeRe: compilePattern_(attempt.rules.includeRootPattern, 'includeRootPattern'),
        excludeRes: compilePatterns_(attempt.rules.excludePatterns, 'excludePatterns'),
        yearlyOnlyRes: compilePatterns_(attempt.rules.yearlyOnlyPatterns, 'yearlyOnlyPatterns')
      };
    }

    var snapshotFolder = DriveApp.getFolderById(attempt.folderId);
    var beforeCounts = { files: attempt.counts.files, shortcuts: attempt.counts.shortcuts,
                         folders: attempt.counts.folders };
    // Budget clamped to 5 min: Apps Script kills executions at ~6 min,
    // and a kill mid-walk would skip the pause-save entirely.
    var ctx = { deadline: Date.now() + Math.min(CONFIG.timeBudgetMs, 5 * 60 * 1000),
                paused: false, attempt: attempt, rules: walkRules,
                runType: attempt.runType, doneFolders: attempt.doneFolders };
    try {
      for (var i = 0; i < attempt.roots.length && !ctx.paused; i++) {
        var root = attempt.roots[i];
        walkFolder_(DriveApp.getFolderById(root.srcId),
                    DriveApp.getFolderById(root.destId), ctx, root.name);
      }
    } catch (e) {
      // An unexpected failure mid-walk must not break the resume chain:
      // record it, persist the attempt, schedule the next segment, and
      // end this execution quietly. The walk is idempotent, so the next
      // segment simply picks up where this one stopped.
      attempt.errorCount = (attempt.errorCount || 0) + 1;
      if (attempt.errorCount >= 10) {
        // A permanent error (e.g. a source root deleted mid-attempt)
        // must not loop forever burning quota: stop and say so.
        addLog_(attempt, 'FAILED — 10 consecutive error segments (' + e.message +
                         '); auto-resume stopped. Fix the cause, then run ' +
                         'runSnapshot() by hand to resume this attempt.');
        try { writeLogFile_(attempt, 'FAILED'); } catch (ignored) {}
        state.data.inProgress = attempt;
        try { saveState_(state); } catch (ignored) {}
        return;
      }
      addLog_(attempt, 'ERROR — unexpected failure (' + e.message +
                       '); resume scheduled in ~1 minute.');
      try { writeLogFile_(attempt, 'ERROR'); } catch (ignored) {}
      state.data.inProgress = attempt;
      try { saveState_(state); } catch (ignored) {}
      scheduleResume_();
      return;
    }

    if (ctx.paused) {
      attempt.errorCount = 0;  // a clean pause means the chain is healthy
      if (attempt.counts.files === beforeCounts.files &&
          attempt.counts.shortcuts === beforeCounts.shortcuts &&
          attempt.counts.folders === beforeCounts.folders) {
        addLog_(attempt, 'WARNING — this segment copied nothing new. If this ' +
                         'repeats every segment, the walk is stuck (e.g. one ' +
                         'folder too large to list within the time budget).');
      }
      addLog_(attempt, 'Out of time — resume scheduled in ~1 minute. Counts so far: ' +
                       JSON.stringify(attempt.counts));
      writeLogFile_(attempt, 'IN PROGRESS');
      state.data.inProgress = attempt;
      // Schedule the resume BEFORE saving state: if the save itself
      // fails, the trigger still fires and the next segment resumes
      // from the last good state (the walk is idempotent).
      scheduleResume_();
      if (!saveState_(state)) {
        throw new Error('state.json could not be saved. The resume trigger IS scheduled; the next segment resumes from the last good state.');
      }
    } else {
      snapshotFolder.setName(attempt.name);  // drops the __INCOMPLETE suffix
      addLog_(attempt, 'Snapshot complete. Counts: ' + JSON.stringify(attempt.counts));
      writeLogFile_(attempt, 'COMPLETE');
      state.data.inProgress = null;
      state.data.lastCompleted = { name: attempt.name, completedAt: new Date().toISOString() };
      saveState_(state);
      clearResumeTriggers_();
      Logger.log('SNAPSHOT COMPLETE: ' + attempt.name + ' — ' + JSON.stringify(attempt.counts));
    }
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------ RULES
function compilePattern_(pattern, label) {
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error('Invalid regex in CONFIG.' + label + ' — "' + pattern + '": ' + e.message);
  }
}

function compilePatterns_(patterns, label) {
  var out = [];
  for (var i = 0; i < patterns.length; i++) out.push(compilePattern_(patterns[i], label));
  return out;
}

function matchesAny_(regexes, path) {
  for (var i = 0; i < regexes.length; i++) {
    if (regexes[i].test(path)) return true;
  }
  return false;
}

// ------------------------------------------------------------- AUTO-TYPING
/**
 * Decides a NEW snapshot's type from the snapshots already on disk.
 * The snapshot folders are the record: a COMPLETE folder named
 * yyyy-MM-dd_HHmmss_<type> satisfies its period (and, for yearly /
 * monthly, the smaller periods inside it). __INCOMPLETE folders don't
 * match the name pattern, so they never count as coverage.
 * Returns 'yearly' if no yearly snapshot exists for this calendar
 * year, else 'monthly' if none for this month, else 'weekly'.
 * ('test' snapshots count as weekly scope — that's what they copy.)
 */
function determineRunType_(xx) {
  var today = Utilities.formatDate(new Date(), CONFIG.timezone, 'yyyy-MM-dd');
  var year = today.substring(0, 4);
  var month = today.substring(0, 7);
  var week = sundayKey_(today);
  var have = { yearly: false, monthly: false, weekly: false };

  var backups = getOrCreateChildFolder_(xx, CONFIG.backupsFolderName);
  var years = [String(Number(year) - 1), year];  // a week can span New Year
  for (var yi = 0; yi < years.length; yi++) {
    var yIt = backups.getFoldersByName(years[yi]);
    if (!yIt.hasNext()) continue;
    var subs = yIt.next().getFolders();
    while (subs.hasNext()) {
      var m = subs.next().getName().match(/^(\d{4}-\d{2}-\d{2})_\d{6}_(yearly|monthly|weekly|test)$/);
      if (!m) continue;
      var d = m[1], t = m[2];
      if (t === 'yearly') {
        if (d.substring(0, 4) === year) have.yearly = true;
        if (d.substring(0, 7) === month) have.monthly = true;
        if (sundayKey_(d) === week) have.weekly = true;
      } else if (t === 'monthly') {
        if (d.substring(0, 7) === month) have.monthly = true;
        if (sundayKey_(d) === week) have.weekly = true;
      } else {  // weekly or test
        if (sundayKey_(d) === week) have.weekly = true;
      }
    }
  }
  var type = !have.yearly ? 'yearly' : (!have.monthly ? 'monthly' : 'weekly');
  Logger.log('Snapshot coverage — yearly: ' + have.yearly + ', monthly: ' +
             have.monthly + ', weekly: ' + have.weekly + ' -> running ' + type);
  return type;
}

/** The Sunday (yyyy-MM-dd) starting the week that contains the date. */
function sundayKey_(yyyyMmDd) {
  var p = yyyyMmDd.split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());  // getUTCDay: 0 = Sunday
  return d.toISOString().substring(0, 10);
}

// ------------------------------------------------------------------ START
/** Finds (or creates) the snapshots root folder and name-checks it. */
function getSnapshotsRoot_() {
  var xx;
  if (CONFIG.snapshotsFolderId) {
    xx = DriveApp.getFolderById(CONFIG.snapshotsFolderId);
  } else {
    var it = DriveApp.getRootFolder().getFoldersByName(CONFIG.snapshotsFolderName);
    xx = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(CONFIG.snapshotsFolderName);
  }
  if (xx.getName() !== CONFIG.snapshotsFolderName) {
    throw new Error('Snapshots folder ID points at "' + xx.getName() +
                    '", expected "' + CONFIG.snapshotsFolderName + '". Stopping.');
  }
  return xx;
}

/**
 * Applies the INCLUDE rule (and root-level EXCLUDE / YEARLY-ONLY) to the
 * top-level folders of My Drive. Returns [{ name, folder }].
 */
function selectSourceRoots_(xx, runType, rules) {
  var selected = [];
  var it = DriveApp.getRootFolder().getFolders();
  while (it.hasNext()) {
    var folder = it.next();
    var name = folder.getName();
    if (folder.getId() === xx.getId()) continue;          // never snapshot the snapshots
    if (!rules.includeRe.test(name)) continue;            // rule 1: include
    if (matchesAny_(rules.excludeRes, name)) {            // rule 2 at root level
      Logger.log('Root "' + name + '" matches an exclude pattern — skipped.');
      continue;
    }
    if (runType !== 'yearly' && matchesAny_(rules.yearlyOnlyRes, name)) {
      Logger.log('Root "' + name + '" is yearly-only — skipped for a ' + runType + ' run.');
      continue;
    }
    selected.push({ name: name, folder: folder });
  }
  if (selected.length === 0) {
    throw new Error('Include pattern "' + CONFIG.includeRootPattern +
                    '" matched no top-level folders. Nothing to snapshot — stopping.');
  }
  return selected;
}

function startAttempt_(xx, systemFolder, runType, rules) {
  var stamp = Utilities.formatDate(new Date(), CONFIG.timezone, 'yyyy-MM-dd_HHmmss');
  var name = stamp + '_' + runType;
  var yyyy = stamp.substring(0, 4);  // snapshots are filed by year only

  var selected = selectSourceRoots_(xx, runType, rules);

  var backupsFolder = getOrCreateChildFolder_(xx, CONFIG.backupsFolderName);
  var yearFolder = getOrCreateChildFolder_(backupsFolder, yyyy);
  var snapshotFolder = yearFolder.createFolder(name + '__INCOMPLETE');

  var roots = [];
  for (var i = 0; i < selected.length; i++) {
    var destRoot = snapshotFolder.createFolder(selected[i].name);
    roots.push({ name: selected[i].name,
                 srcId: selected[i].folder.getId(),
                 destId: destRoot.getId() });
  }

  var logsRoot = getOrCreateChildFolder_(systemFolder, CONFIG.logsFolderName);
  // Create the log file BEFORE copying, so every attempt leaves a log —
  // even one that dies mid-copy. Logs live FLAT in System/Logs.
  var logFile = logsRoot.createFile(name + '.log.txt', '', MimeType.PLAIN_TEXT);

  var attempt = {
    name: name,
    runType: runType,
    folderId: snapshotFolder.getId(),
    logFileId: logFile.getId(),
    startedAt: new Date().toISOString(),
    roots: roots,
    counts: { folders: roots.length, files: 0, shortcuts: 0, shortcutFailures: 0,
              copyFailures: 0, alreadyThere: 0, excluded: 0, yearlySkipped: 0,
              doneSkipped: 0 },
    doneFolders: {},
    errorCount: 0,
    // The rules this attempt runs under, frozen at start: resuming
    // after a CONFIG edit must not change them mid-snapshot.
    rules: { includeRootPattern: CONFIG.includeRootPattern,
             excludePatterns: CONFIG.excludePatterns.slice(),
             yearlyOnlyPatterns: CONFIG.yearlyOnlyPatterns.slice() },
    logLines: []
  };
  addLog_(attempt, 'Snapshot attempt started (' + runType + '). Roots matching include "' +
                   CONFIG.includeRootPattern + '": ' +
                   roots.map(function (r) { return r.name; }).join(', '));
  writeLogFile_(attempt, 'IN PROGRESS');
  return attempt;
}

// --------------------------------------------------------------- COPY WALK
/**
 * Deep-copies srcFolder into dstFolder. relPath is srcFolder's path
 * from My Drive root (e.g. '03_Finance/2024 Taxes') and is what the
 * EXCLUDE / YEARLY-ONLY patterns are tested against. Skips anything
 * already in the destination (that's what makes re-walking after an
 * interruption safe). Returns TRUE only when the folder's whole subtree
 * is completely copied — the caller then records the folder in
 * ctx.doneFolders so future segments prune it on sight instead of
 * re-listing it. Sets ctx.paused and unwinds (returning false) when
 * out of time.
 */
function walkFolder_(srcFolder, dstFolder, ctx, relPath) {
  if (ctx.paused) return false;
  if (ctx.doneFolders[srcFolder.getId()]) {
    ctx.attempt.counts.doneSkipped++;
    return true;  // whole subtree already done in an earlier segment
  }

  // Files already in the destination, counted by name AND kind (Drive
  // allows duplicate names — and even a file and a shortcut sharing a
  // name — so a plain name count could skip the wrong twin on resume).
  var existing = {};
  var dit = dstFolder.getFiles();
  while (dit.hasNext()) {
    var df = dit.next();
    var dk = df.getName() + '|' +
      (df.getMimeType() === 'application/vnd.google-apps.shortcut' ? 's' : 'f');
    existing[dk] = (existing[dk] || 0) + 1;
  }

  var files = srcFolder.getFiles();
  while (files.hasNext()) {
    if (Date.now() > ctx.deadline) { ctx.paused = true; return false; }
    var file = files.next();
    var filePath = relPath + '/' + file.getName();
    if (matchesAny_(ctx.rules.excludeRes, filePath)) {
      ctx.attempt.counts.excluded++;
      continue;
    }
    if (ctx.runType !== 'yearly' && matchesAny_(ctx.rules.yearlyOnlyRes, filePath)) {
      ctx.attempt.counts.yearlySkipped++;
      continue;
    }
    var fkey = file.getName() + '|' +
      (file.getMimeType() === 'application/vnd.google-apps.shortcut' ? 's' : 'f');
    if (existing[fkey] > 0) {
      existing[fkey]--;
      ctx.attempt.counts.alreadyThere++;
    } else {
      copyOne_(file, dstFolder, ctx);
    }
  }

  var subs = srcFolder.getFolders();
  var seenSubNames = {};
  while (subs.hasNext()) {
    if (ctx.paused) return false;
    if (Date.now() > ctx.deadline) { ctx.paused = true; return false; }
    var sub = subs.next();
    var subPath = relPath + '/' + sub.getName();
    if (matchesAny_(ctx.rules.excludeRes, subPath)) {
      ctx.attempt.counts.excluded++;  // the whole subtree goes with it
      continue;
    }
    if (ctx.runType !== 'yearly' && matchesAny_(ctx.rules.yearlyOnlyRes, subPath)) {
      ctx.attempt.counts.yearlySkipped++;
      continue;
    }
    if (ctx.doneFolders[sub.getId()]) {
      ctx.attempt.counts.doneSkipped++;
      continue;  // pruned on sight — no destination lookup, no listing
    }
    if (seenSubNames[sub.getName()]) {
      // Drive allows two folders with the same name side by side; the
      // snapshot resolves destination folders by name, so the twins'
      // contents would merge into one. Surface it loudly instead of
      // letting the structure silently diverge from the source.
      addLog_(ctx.attempt, 'ERROR — duplicate folder name "' + sub.getName() +
                           '" inside ' + relPath + ': same-name sibling folders ' +
                           'cannot be told apart in the snapshot; their contents merge.');
    }
    seenSubNames[sub.getName()] = true;
    var got = getChildFolder_(dstFolder, sub.getName());
    if (got.created) ctx.attempt.counts.folders++;
    if (!walkFolder_(sub, got.folder, ctx, subPath)) return false;
  }

  ctx.doneFolders[srcFolder.getId()] = true;  // subtree fully copied
  return true;
}

function copyOne_(file, dstFolder, ctx) {
  if (file.getMimeType() === 'application/vnd.google-apps.shortcut') {
    // Shortcuts are copied AS shortcuts: a new shortcut in the snapshot,
    // same name, pointing at the SAME target ID. The target is never
    // followed or copied — that's the point of a shortcut (it may point
    // at a heavy file that deliberately lives outside snapshot scope).
    try {
      copyShortcutAsShortcut_(file, dstFolder.getId());
      ctx.attempt.counts.shortcuts++;
    } catch (e) {
      addLog_(ctx.attempt, 'ERROR — could not copy shortcut "' + file.getName() +
                           '": ' + e.message);
      ctx.attempt.counts.shortcutFailures++;
    }
    return;
  }
  // A single uncopyable file (copy-restricted, owner-disabled
  // downloads, a transient API error) must not kill the whole run:
  // log it loudly, count it, and move on — same policy as shortcuts.
  // It will be retried on the next segment (transient errors clear).
  try {
    file.makeCopy(file.getName(), dstFolder);  // server-side copy
    ctx.attempt.counts.files++;
  } catch (e) {
    addLog_(ctx.attempt, 'ERROR — could not copy file "' + file.getName() +
                         '": ' + e.message);
    ctx.attempt.counts.copyFailures++;
  }
}

/**
 * Recreates a Drive shortcut pointing at the original's target, via the
 * Drive API (v3) directly with the script's own OAuth token — DriveApp
 * can't create shortcuts, and this way there's no extra service to
 * enable in the editor.
 */
function copyShortcutAsShortcut_(file, destFolderId) {
  var headers = {
    'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
    'Content-Type': 'application/json'
  };

  var getResp = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' +
      encodeURIComponent(file.getId()) + '?fields=shortcutDetails',
    { method: 'get', headers: headers, muteHttpExceptions: true });
  if (getResp.getResponseCode() !== 200) {
    throw new Error('could not read shortcut target (HTTP ' +
                    getResp.getResponseCode() + ')');
  }
  var targetId = (JSON.parse(getResp.getContentText()).shortcutDetails || {}).targetId;
  if (!targetId) throw new Error('shortcut has no targetId');

  var createResp = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files?fields=id,shortcutDetails',
    {
      method: 'post',
      headers: headers,
      payload: JSON.stringify({
        name: file.getName(),
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutDetails: { targetId: targetId },
        parents: [destFolderId]
      }),
      muteHttpExceptions: true
    });
  var code = createResp.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error('shortcut create failed (HTTP ' + code + '): ' +
                    createResp.getContentText());
  }
  var created = JSON.parse(createResp.getContentText());
  if (!created.shortcutDetails || created.shortcutDetails.targetId !== targetId) {
    throw new Error('created shortcut points somewhere unexpected');
  }
}

// ------------------------------------------------------- FOLDERS AND LOGS
function getOrCreateChildFolder_(parentFolder, name) {
  return getChildFolder_(parentFolder, name).folder;
}

/** One name lookup instead of two: returns the child folder plus
 *  whether it had to be created. */
function getChildFolder_(parentFolder, name) {
  var it = parentFolder.getFoldersByName(name);
  if (it.hasNext()) return { folder: it.next(), created: false };
  return { folder: parentFolder.createFolder(name), created: true };
}

function addLog_(attempt, message) {
  attempt.logLines.push('[' + new Date().toISOString() + '] ' + message);
  Logger.log(message);
}

/** (Re)writes this attempt's log file in System/Logs/ (flat). */
function writeLogFile_(attempt, status) {
  var pats = attempt.rules || CONFIG;  // the rules this attempt runs under
  var header = [
    'Drive Time-Travel Snapshot — attempt log',
    'Snapshot: ' + attempt.name,
    'Status: ' + status,
    'Started: ' + attempt.startedAt,
    'Run type: ' + attempt.runType,
    'Roots: ' + attempt.roots.map(function (r) { return r.name; }).join(', '),
    'Include pattern: ' + pats.includeRootPattern,
    'Exclude patterns: ' + JSON.stringify(pats.excludePatterns),
    'Yearly-only patterns: ' + JSON.stringify(pats.yearlyOnlyPatterns),
    'Counts: ' + JSON.stringify(attempt.counts),
    '----------------------------------------'
  ];
  updateFileText_(attempt.logFileId,
                  header.concat(attempt.logLines).join('\n') + '\n',
                  'text/plain; charset=UTF-8');
}

// ------------------------------------------------------------------- STATE
/**
 * The whole state system: one JSON file in System/.
 * Returns { fileId, data } where data is
 * { version, inProgress, lastCompleted }.
 */
function loadState_(systemFolder) {
  var it = systemFolder.getFilesByName(CONFIG.stateFileName);
  var file;
  if (it.hasNext()) {
    file = it.next();
    try {
      var data = JSON.parse(file.getBlob().getDataAsString());
      if (data && typeof data === 'object') return { fileId: file.getId(), data: data };
    } catch (e) {
      Logger.log('WARNING — state.json is unreadable, starting from empty state: ' + e.message);
    }
    return { fileId: file.getId(), data: { version: 1, inProgress: null, lastCompleted: null } };
  }
  file = systemFolder.createFile(CONFIG.stateFileName,
    JSON.stringify({ version: 1, inProgress: null, lastCompleted: null }, null, 2),
    'application/json');
  return { fileId: file.getId(), data: { version: 1, inProgress: null, lastCompleted: null } };
}

/** Saves state.json. Returns TRUE on success (one retry on failure) —
 *  callers that act on state being durable MUST check the result:
 *  proceeding on a state save that silently failed can strand an
 *  attempt or start a duplicate. */
function saveState_(state) {
  var text = JSON.stringify(state.data, null, 2);
  var ok = updateFileText_(state.fileId, text, 'application/json; charset=UTF-8');
  if (!ok) {
    Logger.log('Retrying state.json save...');
    ok = updateFileText_(state.fileId, text, 'application/json; charset=UTF-8');
  }
  return ok;
}

/** Overwrites a Drive file's contents via the Drive API upload endpoint. */
function updateFileText_(fileId, text, mimeType) {
  var resp = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files/' +
      encodeURIComponent(fileId) + '?uploadType=media',
    {
      method: 'patch',
      headers: {
        'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
        'Content-Type': mimeType
      },
      payload: text,
      muteHttpExceptions: true
    });
  if (resp.getResponseCode() !== 200) {
    Logger.log('WARNING — could not write file ' + fileId +
               ' (HTTP ' + resp.getResponseCode() + ')');
  }
  return resp.getResponseCode() === 200;
}

// ------------------------------------------------------------ RESUME TRIGGER
// Resume triggers use their own dedicated handler (resumeSnapshot_);
// clearResumeTriggers_ deletes only those, so a future weekly trigger
// on runSnapshot can never be mistaken for a resume trigger.
function scheduleResume_() {
  clearResumeTriggers_();
  ScriptApp.newTrigger('resumeSnapshot_')
    .timeBased()
    .after(60 * 1000)
    .create();
}

function clearResumeTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'resumeSnapshot_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}
