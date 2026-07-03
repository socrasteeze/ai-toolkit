# Training Config Presets

Fork addition (see `FORK_NOTES.md`). Files in this folder appear in the **Presets** dialog
on the New Training Job page in the UI.

- Any ai-toolkit config works: UI JSON exports, CLI-style YAML from `config/examples/`, or
  configs shared by other users. Supported extensions: `.json`, `.jsonc`, `.yaml`, `.yml`.
- Loading a preset applies its training recipe (model, network, train, save, sample, and
  dataset *settings*) but keeps your current job name and dataset folder selections.
- Saving a preset from the UI strips machine-specific values (job name, dataset paths,
  training folder) so the file is shareable as-is.
- Missing fields are filled from the UI defaults on load, so partial configs are fine.
- The folder location can be overridden with a `PRESETS_FOLDER` row in the UI settings
  database; it defaults to `<repo>/presets`.
