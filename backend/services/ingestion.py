"""Ebook ingestion — format-dispatched parsers producing normalized chapters.

Supports: EPUB (via ebooklib), FB2 (via lxml), TXT (via chardet), PDF (via PyMuPDF).
PDF parsing is best-effort: strips repeated headers/footers and de-hyphenates.
Does NOT call any LLM or TTS service — pure synchronous parsing only.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path


class IngestionError(Exception):
    """Raised for unsupported or corrupt input files."""


@dataclass
class ParsedChapter:
    number: int
    title: str | None
    text: str
    word_count: int = 0


@dataclass
class ParsedBook:
    title: str
    author: str | None
    source_format: str
    chapters: list[ParsedChapter] = field(default_factory=list)
    cover_bytes: bytes | None = None


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def parse_book(path: str, source_format: str) -> ParsedBook:
    """Dispatch to format-specific parser and return a normalised ParsedBook.

    Args:
        path: Absolute or relative filesystem path to the ebook file.
        source_format: One of 'epub', 'fb2', 'txt', 'pdf' (leading dot OK, e.g. '.epub').

    Returns:
        ParsedBook with chapters, metadata, and optional cover bytes.

    Raises:
        IngestionError: If the format is unsupported or the file is corrupt/unreadable.
    """
    fmt = source_format.lower().lstrip(".")
    try:
        if fmt == "epub":
            return _parse_epub(path)
        if fmt == "fb2":
            return _parse_fb2(path)
        if fmt == "txt":
            return _parse_txt(path)
        if fmt == "pdf":
            return _parse_pdf(path)
    except IngestionError:
        raise
    except Exception as exc:  # corrupt / unreadable
        raise IngestionError(f"Failed to parse {fmt!r}: {exc}") from exc
    raise IngestionError(f"Unsupported format: {source_format!r}")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_CHAPTER_RE = re.compile(
    r"^\s*(chapter|глава|part|часть)\b.*$",
    re.IGNORECASE | re.MULTILINE,
)


def _split_into_chapters(text: str, default_title: str | None = None) -> list[ParsedChapter]:
    """Split *text* on chapter-heading lines (or return as a single chapter)."""
    parts = _CHAPTER_RE.split(text)
    # _CHAPTER_RE has no capturing groups, so split() gives alternating
    # [before, sep1, after1, sep2, after2, ...] — actually with MULTILINE
    # and no capturing groups the separators are dropped.  We need to re-scan
    # with finditer to preserve titles.

    matches = list(_CHAPTER_RE.finditer(text))

    if not matches:
        # No headings — whole file is one chapter.
        clean = _clean(text)
        chapter = ParsedChapter(
            number=1,
            title=default_title,
            text=clean,
            word_count=len(clean.split()) if clean else 0,
        )
        return [chapter]

    chapters: list[ParsedChapter] = []
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        body = text[start:end]
        clean = _clean(body)
        chapters.append(ParsedChapter(
            number=idx + 1,
            title=match.group(0).strip(),
            text=clean,
            word_count=len(clean.split()) if clean else 0,
        ))
    return chapters


def _clean(text: str) -> str:
    """Collapse excess blank lines and strip leading/trailing whitespace."""
    # Collapse runs of 3+ newlines to 2
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _strip_html(html_bytes: bytes | str) -> str:
    """Strip HTML tags from *html_bytes*, returning plain text."""
    if isinstance(html_bytes, bytes):
        html_str = html_bytes.decode("utf-8", errors="replace")
    else:
        html_str = html_bytes
    # Remove script/style blocks
    html_str = re.sub(r"<(script|style)[^>]*>.*?</(script|style)>", "", html_str, flags=re.DOTALL | re.IGNORECASE)
    # Replace block-level tags with newlines for paragraph separation
    html_str = re.sub(r"</(p|div|h[1-6]|li|tr|br)[^>]*>", "\n", html_str, flags=re.IGNORECASE)
    html_str = re.sub(r"<br\s*/?>", "\n", html_str, flags=re.IGNORECASE)
    # Strip all remaining tags
    html_str = re.sub(r"<[^>]+>", "", html_str)
    # Decode common HTML entities
    html_str = (
        html_str
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&apos;", "'")
    )
    return html_str


# ---------------------------------------------------------------------------
# EPUB parser
# ---------------------------------------------------------------------------

def _parse_epub(path: str) -> ParsedBook:
    import ebooklib
    from ebooklib import epub

    try:
        book = epub.read_epub(path, options={"ignore_ncx": True})
    except Exception as exc:
        raise IngestionError(f"Cannot open EPUB: {exc}") from exc

    # Metadata
    title_meta = book.get_metadata("DC", "title")
    title = title_meta[0][0] if title_meta else Path(path).stem

    creator_meta = book.get_metadata("DC", "creator")
    author = creator_meta[0][0] if creator_meta else None

    # Cover image
    cover_bytes: bytes | None = None
    for item in book.get_items():
        if item.get_type() == ebooklib.ITEM_COVER:
            cover_bytes = item.get_content()
            break
    if cover_bytes is None:
        cover_item = book.get_item_with_id("cover")
        if cover_item is not None:
            cover_bytes = cover_item.get_content()

    # Chapters — iterate document items in spine order
    chapters: list[ParsedChapter] = []
    chapter_num = 0
    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        raw_content = item.get_content()
        if not raw_content:
            continue
        text = _strip_html(raw_content)
        text = _clean(text)
        if not text:
            continue
        chapter_num += 1
        chapters.append(ParsedChapter(
            number=chapter_num,
            title=item.get_name(),
            text=text,
            word_count=len(text.split()),
        ))

    return ParsedBook(
        title=title,
        author=author,
        source_format="epub",
        chapters=chapters,
        cover_bytes=cover_bytes,
    )


# ---------------------------------------------------------------------------
# FB2 parser
# ---------------------------------------------------------------------------

_FB2_NS = "http://www.gribuser.ru/xml/fictionbook/2.0"


def _fb2_text(elem) -> str:
    """Recursively collect text from an lxml element."""
    parts: list[str] = []
    if elem.text:
        parts.append(elem.text)
    for child in elem:
        parts.append(_fb2_text(child))
        if child.tail:
            parts.append(child.tail)
    return " ".join(p for p in parts if p.strip())


def _parse_fb2(path: str) -> ParsedBook:
    from lxml import etree

    try:
        tree = etree.parse(path)
    except Exception as exc:
        raise IngestionError(f"Cannot parse FB2 XML: {exc}") from exc

    root = tree.getroot()
    ns = _FB2_NS

    # Metadata
    title_el = root.find(f".//{{{ns}}}book-title")
    title = title_el.text.strip() if title_el is not None and title_el.text else Path(path).stem

    first_name_el = root.find(f".//{{{ns}}}first-name")
    last_name_el = root.find(f".//{{{ns}}}last-name")
    parts = []
    if first_name_el is not None and first_name_el.text:
        parts.append(first_name_el.text.strip())
    if last_name_el is not None and last_name_el.text:
        parts.append(last_name_el.text.strip())
    author = " ".join(parts) if parts else None

    # Sections → chapters
    body = root.find(f"{{{ns}}}body")
    if body is None:
        # Fallback: try without namespace
        body = root.find("body")

    chapters: list[ParsedChapter] = []
    if body is not None:
        sections = body.findall(f"{{{ns}}}section")
        if not sections:
            sections = body.findall("section")
        for idx, section in enumerate(sections):
            # Extract title if present
            title_el2 = section.find(f"{{{ns}}}title")
            chapter_title: str | None = None
            if title_el2 is not None:
                chapter_title = _fb2_text(title_el2).strip() or None

            # All <p> elements (recursively, to handle nested sections)
            paragraphs = section.findall(f".//{{{ns}}}p")
            if not paragraphs:
                paragraphs = section.findall(".//p")
            lines = []
            for p in paragraphs:
                ptext = _fb2_text(p).strip()
                if ptext:
                    lines.append(ptext)
            text = _clean("\n\n".join(lines))
            chapters.append(ParsedChapter(
                number=idx + 1,
                title=chapter_title,
                text=text,
                word_count=len(text.split()) if text else 0,
            ))

    return ParsedBook(
        title=title,
        author=author,
        source_format="fb2",
        chapters=chapters,
    )


# ---------------------------------------------------------------------------
# TXT parser
# ---------------------------------------------------------------------------

def _parse_txt(path: str) -> ParsedBook:
    import chardet

    raw = Path(path).read_bytes()
    detected = chardet.detect(raw)
    encoding = detected.get("encoding") or "utf-8"
    try:
        text = raw.decode(encoding)
    except (UnicodeDecodeError, LookupError):
        text = raw.decode("utf-8", errors="replace")

    title = Path(path).stem
    chapters = _split_into_chapters(text, default_title=title)

    return ParsedBook(
        title=title,
        author=None,
        source_format="txt",
        chapters=chapters,
    )


# ---------------------------------------------------------------------------
# PDF parser
# ---------------------------------------------------------------------------

def _parse_pdf(path: str) -> ParsedBook:
    """Best-effort PDF text extraction with header/footer stripping and de-hyphenation."""
    import fitz  # PyMuPDF

    try:
        doc = fitz.open(path)
    except Exception as exc:
        raise IngestionError(f"Cannot open PDF: {exc}") from exc

    title = Path(path).stem
    num_pages = len(doc)

    if num_pages == 0:
        doc.close()
        return ParsedBook(title=title, author=None, source_format="pdf")

    # Collect per-page lines with their y-coordinates (rounded to nearest pt)
    page_lines: list[list[tuple[int, str]]] = []  # per page: list of (y_rounded, line_text)
    for page in doc:
        blocks = page.get_text("dict").get("blocks", [])
        lines_on_page: list[tuple[int, str]] = []
        for block in blocks:
            if block.get("type") != 0:  # 0 = text block
                continue
            for line in block.get("lines", []):
                y = round(line["bbox"][1])  # top-y coordinate rounded to int
                line_text = " ".join(
                    span["text"] for span in line.get("spans", [])
                ).strip()
                if line_text:
                    lines_on_page.append((y, line_text))
        page_lines.append(lines_on_page)

    doc.close()

    # Identify repeated y-positions (header/footer heuristic: same y on ≥50% of pages)
    if num_pages >= 2:
        from collections import Counter
        y_counts: Counter[int] = Counter()
        for lines in page_lines:
            for y, _ in lines:
                y_counts[y] += 1
        threshold = num_pages * 0.5
        repeated_ys = {y for y, count in y_counts.items() if count >= threshold}
    else:
        repeated_ys: set[int] = set()

    # Build full text with header/footer lines removed
    page_texts: list[str] = []
    for lines in page_lines:
        filtered = [line for y, line in lines if y not in repeated_ys]
        page_texts.append("\n".join(filtered))

    full_text = "\n\n".join(page_texts)

    # De-hyphenate: "exam-\nple" → "example"
    full_text = re.sub(r"-\n(\w)", r"\1", full_text)

    chapters = _split_into_chapters(full_text, default_title=title)

    return ParsedBook(
        title=title,
        author=None,
        source_format="pdf",
        chapters=chapters,
    )
