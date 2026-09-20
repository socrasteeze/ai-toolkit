"""Contract tests for scripts/clean_captions.py (the caption-surgery CLI).

Deliberately imports ONLY that module, not qol_common — everything the tests
exercise is pure text, so this suite runs on any interpreter with no torch, no
huggingface_hub and no dataset on disk. The dataset walk is imported lazily
inside main() for exactly that reason.

What is pinned here is the behaviour that is easy to regress and expensive to
notice: that a removal never orphans the words around it, that a trigger word
keeps its casing, and that nothing can produce an empty caption.

Run from the repo root:
    python testing/test_clean_captions.py
"""

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
for entry in (REPO_ROOT, REPO_ROOT / "scripts"):
    if str(entry) not in sys.path:
        sys.path.insert(0, str(entry))

import clean_captions as cc  # noqa: E402


def clean(text, subject="dojacat", aggressive=False, categories=None):
    cats = list(categories or cc.DEFAULT_CATEGORIES)
    if aggressive:
        cats += [c for c in cc.AGGRESSIVE_CATEGORIES if c not in cats]
    tag_pats, prose_pats = cc.compile_patterns(cats, [], [])
    hits = {}
    mode = cc.detect_mode(text)
    if mode == "tags":
        return cc.clean_tags(text, tag_pats, hits), hits, mode
    return cc.clean_prose(text, prose_pats, hits, subject, aggressive), hits, mode


class ModeDetection(unittest.TestCase):
    def test_comma_separated_short_parts_are_tags(self):
        self.assertEqual(cc.detect_mode("1girl, solo, blue eyes, red dress"), "tags")

    def test_a_sentence_is_prose_even_with_commas(self):
        self.assertEqual(cc.detect_mode("A woman in a red dress, standing in a park."), "prose")

    def test_ambiguity_resolves_to_prose(self):
        # one part, or long parts: prose cleaning is the conservative side
        self.assertEqual(cc.detect_mode("a red dress"), "prose")
        self.assertEqual(cc.detect_mode("a woman wearing a long red dress, holding a paper cup"), "prose")

    def test_empty_is_prose_not_a_crash(self):
        self.assertEqual(cc.detect_mode(""), "prose")


class TagMode(unittest.TestCase):
    def test_identity_tags_go_and_the_rest_stays_in_order(self):
        out, hits, mode = clean("1girl, solo, blue eyes, blonde hair, pale skin, red dress, smiling")
        self.assertEqual(mode, "tags")
        self.assertEqual(out, "solo, red dress, smiling")
        self.assertEqual(hits, {"gendered": 1, "eye-color": 1, "hair-color": 1, "skin-tone": 1})

    def test_wd14_count_tags_are_gendered(self):
        out, _, _ = clean("2girls, 1boy, solo, red dress")
        self.assertEqual(out, "solo, red dress")

    def test_variable_attributes_survive(self):
        # pose, expression, clothing, framing: the things captions SHOULD carry
        text = "solo, looking at viewer, smiling, red dress, outdoors, upper body"
        out, hits, _ = clean(text)
        self.assertEqual(out, text)
        self.assertEqual(hits, {})

    def test_duplicate_tags_collapse(self):
        out, _, _ = clean("solo, red dress, Solo, red dress, smiling")
        self.assertEqual(out, "solo, red dress, smiling")


class ProseMode(unittest.TestCase):
    def test_removal_does_not_orphan_connectors_or_modifiers(self):
        # the 2026-09-20 bug: "and long blonde hair" removed only "blonde hair",
        # leaving "and long" — worse prose than the attribute it deleted.
        out, _, _ = clean(
            "A young woman with blue eyes and long blonde hair wearing a red dress, standing in a park."
        )
        self.assertEqual(out, "dojacat wearing a red dress, standing in a park.")
        for orphan in (" and ", " long ", "  "):
            self.assertNotIn(orphan, f" {out} ".replace("standing", "x"))

    def test_trigger_word_keeps_its_casing(self):
        # tidy() upper-cases a sentence opener; a trigger is case-sensitive and
        # "Dojacat" is not the token that was trained.
        out, _, _ = clean("The image shows a woman with pale skin sitting on a chair.")
        self.assertTrue(out.startswith("dojacat"), out)

    def test_florence_boilerplate_is_stripped(self):
        for lead in (
            "The image shows a woman sitting on a chair.",
            "This is an image of a woman sitting on a chair.",
            "In this image, a woman sitting on a chair.",
        ):
            out, _, _ = clean(lead)
            self.assertNotIn("image", out.lower(), lead)

    def test_subject_substitution_can_be_disabled(self):
        out, hits, _ = clean("A woman with pale skin sitting on a chair.", subject=None)
        self.assertIn("woman", out)
        self.assertNotIn("pale skin", out)
        self.assertNotIn("gendered", hits)

    def test_background_and_second_sentence_survive_without_aggressive(self):
        text = "A woman wearing a red dress. In the background there are trees."
        out, _, _ = clean(text)
        self.assertIn("background", out)

    def test_aggressive_keeps_only_the_first_sentence(self):
        text = "A woman wearing a red dress, standing in a park. In the background there are trees."
        out, hits, _ = clean(text, aggressive=True)
        self.assertEqual(out, "dojacat wearing a red dress, standing in a park.")
        self.assertEqual(hits.get("first-sentence"), 1)

    def test_no_double_spaces_or_dangling_punctuation_anywhere(self):
        for text in (
            "A woman with green eyes, blonde hair, and pale skin, smiling.",
            "A man with short brown hair and green eyes, smiling at the camera.",
            "A girl with blue eyes wearing a hat.",
        ):
            out, _, _ = clean(text)
            self.assertNotIn("  ", out, text)
            self.assertNotIn(" ,", out, text)
            self.assertNotIn(",,", out, text)
            self.assertFalse(out.endswith(","), text)
            self.assertFalse(out.lower().endswith(" and"), text)


class Safety(unittest.TestCase):
    def test_a_caption_that_would_empty_is_detectable(self):
        # the caller skips these rather than writing them — an empty caption is
        # the failure that put untrained images into the source pipeline's runs
        out, _, _ = clean("1girl, blue eyes, blonde hair, pale skin")
        self.assertTrue(cc.is_empty(out), repr(out))

    def test_a_single_token_caption_is_treated_as_prose_and_left_alone(self):
        # documented limitation, pinned rather than hidden: mode detection needs a
        # comma, so a lone WD14 tag takes the prose path, where the count-tag
        # pattern does not apply. Force it with --mode tags if you have such a set.
        self.assertEqual(cc.detect_mode("1girl"), "prose")
        out, _, _ = clean("1girl")
        self.assertEqual(out, "1girl")

    def test_is_empty_only_counts_real_characters(self):
        for blank in ("", "   ", ",", " , . ", "-"):
            self.assertTrue(cc.is_empty(blank), repr(blank))
        for real in ("solo", "a", "red dress"):
            self.assertFalse(cc.is_empty(real), repr(real))

    def test_unrelated_captions_are_returned_byte_identical(self):
        for text in ("solo, red dress, smiling", "A person sitting on a chair."):
            out, hits, _ = clean(text, subject=None)
            self.assertEqual(out, text)
            self.assertEqual(hits, {})

    def test_every_declared_category_compiles_and_is_selectable(self):
        for name in cc.CATEGORIES:
            tag_pats, prose_pats = cc.compile_patterns([name], [], [])
            self.assertTrue(tag_pats or prose_pats, name)

    def test_extra_terms_are_honoured_in_both_modes(self):
        tag_pats, prose_pats = cc.compile_patterns([], ["freckles"], [])
        hits = {}
        self.assertEqual(cc.clean_tags("solo, freckles, red dress", tag_pats, hits), "solo, red dress")
        hits = {}
        out = cc.clean_prose("A person with freckles smiling.", prose_pats, hits, None, False)
        self.assertNotIn("freckles", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
