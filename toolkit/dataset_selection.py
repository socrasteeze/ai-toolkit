import os
from typing import Iterable, List, Optional


def normalize_included_subfolders(value: Optional[Iterable[str]]) -> Optional[List[str]]:
    """Validate immediate child-folder names used to scope a dataset walk."""
    if value is None:
        return None
    if not isinstance(value, (list, tuple)):
        raise ValueError('include_subfolders must be a list of folder names or null')

    normalized = []
    seen = set()
    for name in value:
        if not isinstance(name, str):
            raise ValueError('include_subfolders entries must be strings')
        clean = name
        if (
            not clean.strip()
            or clean in ('.', '..')
            or '/' in clean
            or '\\' in clean
            or os.path.isabs(clean)
        ):
            raise ValueError(f'invalid include_subfolders entry: {name!r}')
        if clean not in seen:
            seen.add(clean)
            normalized.append(clean)
    return normalized


def list_dataset_media_files(
    dataset_path: str,
    extensions: Iterable[str],
    include_loose_files: bool = True,
    include_subfolders: Optional[Iterable[str]] = None,
) -> List[str]:
    """List media under a dataset root using the configured folder scope.

    ``include_subfolders=None`` preserves the legacy recursive walk. A list selects
    immediate child folders, with each selected child included recursively. An empty
    list keeps only loose files when ``include_loose_files`` is true.
    """
    extension_tuple = tuple(ext.lower() for ext in extensions)
    selected = normalize_included_subfolders(include_subfolders)
    selected_set = set(selected) if selected is not None else None
    file_list = []

    for root, dirs, files in os.walk(dataset_path):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d != '_controls']
        is_root = os.path.normcase(os.path.abspath(root)) == os.path.normcase(
            os.path.abspath(dataset_path)
        )

        if is_root and selected_set is not None:
            dirs[:] = [d for d in dirs if d in selected_set]

        if not is_root or include_loose_files:
            file_list.extend(
                os.path.join(root, file)
                for file in files
                if file.lower().endswith(extension_tuple) and not file.startswith('.')
            )

    return file_list
