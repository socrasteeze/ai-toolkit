import os
import tempfile
import unittest

from toolkit.dataset_selection import (
    list_dataset_media_files,
    normalize_included_subfolders,
)


class DatasetSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = self.temp_dir.name
        for relative_path in (
            'loose.jpg',
            'loose.txt',
            'Folder A/a.jpg',
            'Folder A/Nested/deep.png',
            'Folder B/b.jpg',
            '.hidden.jpg',
            '.thumbs/thumb.jpg',
            '_controls/control.jpg',
        ):
            full_path = os.path.join(self.root, *relative_path.split('/'))
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, 'wb') as handle:
                handle.write(b'test')

    def tearDown(self):
        self.temp_dir.cleanup()

    def relative_files(self, **scope):
        files = list_dataset_media_files(self.root, ('.jpg', '.png'), **scope)
        return sorted(os.path.relpath(path, self.root).replace('\\', '/') for path in files)

    def test_default_scope_preserves_recursive_behavior(self):
        self.assertEqual(
            self.relative_files(),
            ['Folder A/Nested/deep.png', 'Folder A/a.jpg', 'Folder B/b.jpg', 'loose.jpg'],
        )

    def test_parent_can_include_loose_files_and_selected_children(self):
        self.assertEqual(
            self.relative_files(include_loose_files=True, include_subfolders=['Folder A']),
            ['Folder A/Nested/deep.png', 'Folder A/a.jpg', 'loose.jpg'],
        )

    def test_parent_can_exclude_loose_files(self):
        self.assertEqual(
            self.relative_files(include_loose_files=False, include_subfolders=['Folder B']),
            ['Folder B/b.jpg'],
        )

    def test_empty_child_selection_keeps_only_loose_files(self):
        self.assertEqual(
            self.relative_files(include_loose_files=True, include_subfolders=[]),
            ['loose.jpg'],
        )

    def test_selecting_child_path_excludes_parent_and_siblings(self):
        child = os.path.join(self.root, 'Folder A')
        files = list_dataset_media_files(child, ('.jpg', '.png'))
        self.assertEqual(
            sorted(os.path.relpath(path, child).replace('\\', '/') for path in files),
            ['Nested/deep.png', 'a.jpg'],
        )

    def test_invalid_child_names_are_rejected(self):
        for value in ('Folder A', {'Folder A'}, [''], ['..'], ['A/B'], ['A\\B'], [1]):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    normalize_included_subfolders(value)


if __name__ == '__main__':
    unittest.main()
