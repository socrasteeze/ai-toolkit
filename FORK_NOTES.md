# Fork Notes

This fork (socrasteeze/ai-toolkit) adds personal-use features on top of upstream
(ostris/ai-toolkit). See `PLAN.md` for the design. This file is the authoritative list of
every place the fork diverges from upstream — keep it updated so upstream merges stay a
two-minute job.

## Sync procedure

```bash
git fetch upstream
git merge upstream/main
# resolve conflicts (expected only in files listed below), then:
git push origin main
```

## Upstream files modified (the entire merge surface)

| File | Change | Notes for conflict resolution |
|---|---|---|
| `ui/src/app/jobs/new/page.tsx` | +1 import, +1 JSX line mounting `<PresetManager/>` in the TopBar | Re-add the mount next to the "Import Config" button if upstream restructures the TopBar |
| `ui/src/app/jobs/new/SimpleJob.tsx` | +1 import, +1 JSX line mounting `<StepSuggestion/>` under the Steps `NumberInput` | Re-add directly below the Steps field if upstream moves it |

## Fork-only files (never conflict)

- `PLAN.md`, `FORK_NOTES.md`
- `start.bat` — double-click launcher for the UI (`start.bat rebuild` after pulling upstream)
- `presets/` — preset config files (drop-in JSON/YAML)
- `ui/src/server/presetsPath.ts`
- `ui/src/server/datasetFiles.ts`
- `ui/src/app/api/presets/route.ts`
- `ui/src/app/api/presets/[name]/route.ts`
- `ui/src/app/api/datasets/count/route.ts`
- `ui/src/utils/presets.ts`
- `ui/src/utils/stepSuggestion.ts`
- `ui/src/components/PresetManager.tsx`
- `ui/src/components/StepSuggestion.tsx`

## Duplication watch (re-check after each upstream merge)

- `ui/src/server/datasetFiles.ts` duplicates the media-extension whitelist and `_controls`
  exclusion from `ui/src/app/api/datasets/listImages/route.ts` (route files can't export
  helpers). If upstream changes that list, mirror it.
- `ui/src/utils/presets.ts` mirrors the "set required fields" logic from the import flow in
  `ui/src/app/jobs/new/page.tsx` (`sqlite_db_path`, `training_folder`, `device`,
  `performance_log_every`). If upstream adds a required field there, add it here too.
