#!/usr/bin/env python3
"""Caption surgery: strip identity-descriptive attributes from .txt sidecars.

The missing middle stage of the dataset pipeline recorded in
``docs/krea2_field_template_2026_09.md`` sections 5-6. The field operator whose
Krea 2 LoRAs this fork's character recipe comes from captioned with Florence-2
and then deliberately REMOVED eye colour, hair colour, skin tone and the generic
woman/girl/female nouns, so those traits bind to the identity token instead of
to words that get reused in other prompts. ``ARCH_RECIPES.krea2`` has advised the
same practice since before that account and now calls it two-source. Nothing in
this fork implemented it until this script.

What it is NOT: a quality judgement on your captions. It removes terms from
curated lists, nothing more. The lists are module-level constants below --
read them, and add to them with --extra rather than trusting them blindly.

Usage (repo root; no torch, no GPU, no model downloads):
    python scripts/clean_captions.py <dataset_dir>                 # dry run, shows every change
    python scripts/clean_captions.py <dataset_dir> --apply         # writes, backs up to .txt.bak
    python scripts/clean_captions.py <dataset_dir> --apply --aggressive
    python scripts/clean_captions.py <dataset_dir> --restore       # undo from .txt.bak
    python scripts/clean_captions.py <dataset_dir> --categories eye-color,hair-color
    python scripts/clean_captions.py <dataset_dir> --subject dojacat --apply

DRY RUN IS THE DEFAULT. Nothing is written without --apply, and --apply keeps a
.txt.bak beside every file it changes unless you pass --no-backup. --restore puts
them all back.

Two caption shapes, detected per file (override with --mode):
  tags   comma-separated ("1girl, solo, blue eyes, red dress") -- WD14 / booru
         style, what scripts/auto_caption.py writes. Matched terms are dropped
         as whole tags, order and the rest preserved.
  prose  a sentence ("A young woman with blue eyes wearing a red dress") --
         Florence-2 / Qwen3-VL style. Matched phrases are cut WITH their
         connectors and the sentence is repaired (doubled spaces, orphaned
         commas, dangling "with", capitalisation).

The gendered-noun category behaves differently by shape, deliberately. In tags a
noun is a standalone token and deletes cleanly. In prose it is the sentence's
subject, and deleting it produces "A wearing a red dress" -- so prose mode
SUBSTITUTES instead: --subject (default "person"), and passing your trigger word
is the point ("dojacat wearing a red dress"), which is how the field pipeline's
captions ended up reading.

--aggressive adds the two destructive steps that pipeline also used: keep only
the FIRST SENTENCE, and cut background clauses. Off by default because they
throw away composition and setting detail that is legitimately variable, and
because a caption you over-trim cannot be recovered except from the backup.

SAFETY: a file whose caption would come out empty (or punctuation only) is
SKIPPED and reported, never written. An empty caption is precisely the failure
that put untrained images into the source pipeline's own runs.
"""

import argparse
import re
import sys
from pathlib import Path

# qol_common reaches toolkit/, which imports huggingface_hub. Kept out of module scope
# on purpose: everything above main() is pure text, so the cleaning logic imports, tests
# and runs --help on any interpreter, with or without the training venv.

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

# --- term lists (edit these; --extra appends, --categories selects) ------------------
EYE_COLORS = r"blue|green|brown|hazel|grey|gray|amber|golden|gold|violet|purple|black|dark|light|red"
HAIR_COLORS = (
    r"blonde|blond|brunette|brown|black|red|ginger|auburn|silver|white|grey|gray|"
    r"platinum blonde|strawberry blonde|dark brown|light brown|dyed"
)
SKIN_TONES = r"pale|fair|light|dark|tan|tanned|olive|brown|black|ebony|bronze"
GENDERED_NOUNS = r"woman|women|girl|girls|female|lady|ladies|man|men|boy|boys|male|guy|guys|person|people"
# Prose removal has to take the whole noun phrase. Cutting only the matched words leaves
# the connector and any size/style adjective behind ("and long blonde hair" -> "and long"),
# which reads worse than the attribute did. CONNECTOR absorbs the leading conjunction,
# HAIR_STYLE the adjectives that only modify a colour we are deleting.
CONNECTOR = r"(?:,\s*)?\b(?:with|having|has|and|who\s+has)?\s*"
HAIR_STYLE = r"(?:(?:very\s+)?(?:long|short|medium|shoulder-length|chin-length|curly|straight|wavy|braided|loose|thick)\s+)*"

# Each category maps to (tag patterns, prose patterns). Tag patterns match a WHOLE tag.
CATEGORIES = {
    "eye-color": (
        [rf"^(?:{EYE_COLORS})\s+eyes?$", r"^heterochromia$", rf"^eyes?\s+(?:are\s+)?(?:{EYE_COLORS})$"],
        [rf"{CONNECTOR}(?:{EYE_COLORS})\s+eyes\b", r"\bheterochromia\b"],
    ),
    "hair-color": (
        [rf"^(?:{HAIR_COLORS})\s+hair$", r"^(?:blonde|blond|brunette|ginger|redhead)$"],
        [rf"{CONNECTOR}{HAIR_STYLE}(?:{HAIR_COLORS})\s+hair\b"],
    ),
    "skin-tone": (
        [rf"^(?:{SKIN_TONES})\s+skin$", r"^(?:pale|tanned|sun-tanned)$"],
        [rf"{CONNECTOR}(?:{SKIN_TONES})\s+skin\b"],
    ),
    "gendered": (
        [rf"^(?:{GENDERED_NOUNS})$", r"^\d+(?:girl|girls|boy|boys|other|others)$"],
        [],  # prose is a substitution, not a deletion -- see substitute_subject()
    ),
    "boilerplate": (
        [],
        [
            r"^\s*(?:the|this)\s+(?:image|picture|photo|photograph)\s+(?:shows|depicts|features|captures|is\s+of)\s*",
            r"^\s*(?:this\s+is\s+)?(?:an?\s+)?(?:image|picture|photo|photograph)\s+of\s+",
            r"^\s*in\s+(?:this|the)\s+(?:image|picture|photo)\s*,\s*",
            r"^\s*there\s+is\s+",
        ],
    ),
    # --aggressive only
    "background": (
        [r"^(?:simple|white|grey|gray|blurry|outdoors|indoors)\s+background$"],
        [
            r"(?:,|\.|;)?\s*\bin\s+the\s+(?:background|backdrop)\b[^.]*",
            r"(?:,|\.|;)?\s*\bthe\s+background\s+(?:is|shows|features)\b[^.]*",
            r"(?:,|\.|;)?\s*\bagainst\s+an?\s+[^.]*\bbackground\b[^.]*",
            r"(?:,|\.|;)?\s*\bbehind\s+(?:her|him|them)\b[^.]*",
        ],
    ),
}

DEFAULT_CATEGORIES = ["eye-color", "hair-color", "skin-tone", "gendered", "boilerplate"]
AGGRESSIVE_CATEGORIES = ["background"]
SUBJECT_RE = re.compile(
    rf"\b(?:an?|the)\s+(?:(?:young|old|middle-aged|adult|beautiful|attractive|pretty|handsome)\s+)*"
    rf"(?:{GENDERED_NOUNS})\b",
    re.IGNORECASE,
)
BARE_SUBJECT_RE = re.compile(rf"\b(?:{GENDERED_NOUNS})\b", re.IGNORECASE)


def detect_mode(caption: str) -> str:
    """tags when it reads as a comma-separated list, else prose.

    A tag list has commas and short parts and no sentence punctuation; one long
    clause with commas is prose. Ambiguity resolves to prose, the conservative
    side: prose cleaning removes phrases, tag cleaning removes whole tags.
    """
    text = caption.strip()
    if not text:
        return "prose"
    parts = [p.strip() for p in text.split(",") if p.strip()]
    if len(parts) < 2:
        return "prose"
    if re.search(r"[.!?]", text):
        return "prose"
    longest_words = max(len(p.split()) for p in parts)
    return "tags" if longest_words <= 4 else "prose"


def compile_patterns(categories, extra_tags, extra_prose):
    tag_pats, prose_pats = [], []
    for name in categories:
        tags, prose = CATEGORIES[name]
        tag_pats += [(name, re.compile(p, re.IGNORECASE)) for p in tags]
        prose_pats += [(name, re.compile(p, re.IGNORECASE)) for p in prose]
    for term in extra_tags:
        tag_pats.append(("extra", re.compile(rf"^{re.escape(term)}$", re.IGNORECASE)))
        prose_pats.append(("extra", re.compile(rf"(?:,\s*)?\b{re.escape(term)}\b", re.IGNORECASE)))
    for term in extra_prose:
        prose_pats.append(("extra", re.compile(term, re.IGNORECASE)))
    return tag_pats, prose_pats


def clean_tags(caption: str, tag_pats, hits: dict) -> str:
    kept, seen = [], set()
    for raw in caption.split(","):
        tag = raw.strip()
        if not tag:
            continue
        matched = next((name for name, pat in tag_pats if pat.match(tag)), None)
        if matched:
            hits[matched] = hits.get(matched, 0) + 1
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        kept.append(tag)
    return ", ".join(kept)


def substitute_subject(text: str, subject: str, hits: dict) -> str:
    """Replace the generic subject noun phrase with `subject` (once), then any
    remaining bare gendered nouns. Prose only -- deleting the subject outright
    leaves a sentence with no subject."""
    new, n = SUBJECT_RE.subn(subject, text, count=1)
    if n:
        hits["gendered"] = hits.get("gendered", 0) + n
    new, n2 = BARE_SUBJECT_RE.subn(subject, new)
    if n2:
        hits["gendered"] = hits.get("gendered", 0) + n2
    return new


def tidy(text: str, capitalize: bool = True) -> str:
    """Repair what phrase removal leaves behind.

    ``capitalize`` is False when the sentence now opens with a substituted subject:
    a trigger word is case-sensitive, and "Dojacat" is not the token you trained.
    """
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"([,;:])\s*(?=[,.;:])", "", text)
    text = re.sub(r"\b(with|having|has|and|wearing)\s*(?=[,.;])", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^[\s,;:.]+", "", text)
    text = re.sub(r"\s*,\s*$", "", text)
    text = re.sub(r"\b(with|having|has|and)\s*$", "", text, flags=re.IGNORECASE)
    text = text.strip()
    if capitalize and text and text[0].islower():
        text = text[0].upper() + text[1:]
    return text


def clean_prose(caption: str, prose_pats, hits: dict, subject: str, first_sentence: bool) -> str:
    text = caption.strip()
    if first_sentence:
        parts = re.split(r"(?<=[.!?])\s+", text)
        if len(parts) > 1:
            hits["first-sentence"] = hits.get("first-sentence", 0) + 1
            text = parts[0]
    for name, pat in prose_pats:
        text, n = pat.subn(" ", text)
        if n:
            hits[name] = hits.get(name, 0) + n
    if subject is not None:
        text = substitute_subject(text, subject, hits)
    text = tidy(text, capitalize=True)
    # If the subject substitution landed first, restore its exact casing.
    if subject and text[: len(subject)].lower() == subject.lower():
        text = subject + text[len(subject) :]
    return text


def is_empty(text: str) -> bool:
    return not re.sub(r"[\s,.;:!?-]", "", text)


def caption_path(image: Path, ext: str) -> Path:
    return image.with_suffix("." + ext.lstrip("."))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset_dir", type=Path)
    ap.add_argument("--caption-ext", default="txt")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument("--no-backup", action="store_true", help="do not write .bak files alongside changes")
    ap.add_argument("--restore", action="store_true", help="restore every caption from its .bak and exit")
    ap.add_argument("--mode", choices=["auto", "tags", "prose"], default="auto")
    ap.add_argument("--categories", default=",".join(DEFAULT_CATEGORIES),
                    help=f"comma-separated subset of {sorted(CATEGORIES)}")
    ap.add_argument("--aggressive", action="store_true",
                    help="also keep only the first sentence and cut background clauses (prose)")
    ap.add_argument("--subject", default="person",
                    help='prose only: what replaces the generic subject noun. Pass your trigger word to get '
                         '"<trigger> wearing a red dress". Use "" to disable substitution')
    ap.add_argument("--extra", default="", help="comma-separated extra terms to remove (tag-exact and in prose)")
    ap.add_argument("--extra-regex", default="", help="semicolon-separated extra prose regexes to remove")
    ap.add_argument("--quiet", action="store_true", help="summary only, no per-file diff")
    args = ap.parse_args()

    from qol_common import list_images, rel_label  # noqa: PLC0415 — see the note at the top

    folder = args.dataset_dir
    if not folder.is_dir():
        print(f"not a directory: {folder}", file=sys.stderr)
        return 2

    images = list_images(folder, IMAGE_EXTS)
    if not images:
        print(f"no images found under {folder}", file=sys.stderr)
        return 2

    if args.restore:
        restored = 0
        for image in images:
            cap = caption_path(image, args.caption_ext)
            bak = cap.with_suffix(cap.suffix + ".bak")
            if bak.is_file():
                cap.write_text(bak.read_text(encoding="utf-8"), encoding="utf-8")
                bak.unlink()
                restored += 1
        print(f"restored {restored} caption(s) from .bak")
        return 0

    categories = [c.strip() for c in args.categories.split(",") if c.strip()]
    unknown = [c for c in categories if c not in CATEGORIES]
    if unknown:
        print(f"unknown categor{'y' if len(unknown) == 1 else 'ies'}: {', '.join(unknown)}", file=sys.stderr)
        return 2
    if args.aggressive:
        categories += [c for c in AGGRESSIVE_CATEGORIES if c not in categories]

    extra_tags = [t.strip() for t in args.extra.split(",") if t.strip()]
    extra_prose = [r for r in args.extra_regex.split(";") if r.strip()]
    tag_pats, prose_pats = compile_patterns(categories, extra_tags, extra_prose)
    subject = None if args.subject == "" else args.subject

    hits, changed, skipped_empty, missing, unchanged = {}, [], [], 0, 0
    for image in images:
        cap = caption_path(image, args.caption_ext)
        if not cap.is_file():
            missing += 1
            continue
        original = cap.read_text(encoding="utf-8").strip()
        mode = args.mode if args.mode != "auto" else detect_mode(original)
        file_hits = {}
        if mode == "tags":
            new = clean_tags(original, tag_pats, file_hits)
        else:
            new = clean_prose(original, prose_pats, file_hits, subject, args.aggressive)
        if new == original:
            unchanged += 1
            continue
        if is_empty(new):
            skipped_empty.append(rel_label(cap, folder))
            continue
        for k, v in file_hits.items():
            hits[k] = hits.get(k, 0) + v
        changed.append((cap, original, new, mode))

    if not args.quiet:
        for cap, original, new, mode in changed:
            print(f"\n{rel_label(cap, folder)}  [{mode}]")
            print(f"  - {original}")
            print(f"  + {new}")

    if args.apply:
        for cap, original, new, _mode in changed:
            if not args.no_backup:
                cap.with_suffix(cap.suffix + ".bak").write_text(original + "\n", encoding="utf-8")
            cap.write_text(new + "\n", encoding="utf-8")

    print(f"\n{len(images)} image(s), {len(changed)} caption(s) {'rewritten' if args.apply else 'would change'}, "
          f"{unchanged} unchanged")
    if hits:
        print("  removed: " + ", ".join(f"{k} x{v}" for k, v in sorted(hits.items())))
    if missing:
        print(f"  {missing} image(s) have no .{args.caption_ext} sidecar — run scripts/preflight.py")
    if skipped_empty:
        print(f"  SKIPPED {len(skipped_empty)} file(s) that would have been left empty: "
              + ", ".join(skipped_empty[:5]) + (" ..." if len(skipped_empty) > 5 else ""))
    if not args.apply and changed:
        print("  dry run — nothing written. Re-run with --apply (keeps .txt.bak unless --no-backup).")
    elif args.apply and changed and not args.no_backup:
        print("  backups written alongside as .txt.bak — undo with --restore")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
