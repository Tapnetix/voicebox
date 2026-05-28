"""Tests for the ebook ingestion service (all four formats)."""

import pytest

from backend.services.ingestion import parse_book, IngestionError, ParsedBook


def test_txt_detects_encoding_and_splits_chapters(tmp_path):
    p = tmp_path / "book.txt"
    p.write_text("CHAPTER ONE\n\nHello world.\n\nCHAPTER TWO\n\nGoodbye.", encoding="utf-8")
    result = parse_book(str(p), "txt")
    assert isinstance(result, ParsedBook)
    assert len(result.chapters) >= 2
    assert "Hello world" in result.chapters[0].text


def test_txt_cp1251_round_trip(tmp_path):
    p = tmp_path / "ru.txt"
    p.write_bytes("Глава 1\n\nПривет.".encode("cp1251"))
    result = parse_book(str(p), "txt")
    assert "Привет" in result.chapters[0].text


def test_txt_word_count_populated(tmp_path):
    p = tmp_path / "wc.txt"
    p.write_text("CHAPTER ONE\n\nHello world foo bar.", encoding="utf-8")
    result = parse_book(str(p), "txt")
    assert result.chapters[0].word_count > 0


def test_txt_title_from_filename(tmp_path):
    p = tmp_path / "mybook.txt"
    p.write_text("Some content here.", encoding="utf-8")
    result = parse_book(str(p), "txt")
    assert result.title == "mybook"


def test_epub_metadata_and_chapters(tmp_path):
    from ebooklib import epub

    book = epub.EpubBook()
    book.set_title("Silo")
    book.add_author("Hugh Howey")
    c1 = epub.EpubHtml(title="Ch1", file_name="c1.xhtml")
    c1.content = b"<h1>Chapter 1</h1><p>It was a dark night.</p>"
    book.add_item(c1)
    book.spine = ["nav", c1]
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    path = tmp_path / "silo.epub"
    epub.write_epub(str(path), book)
    result = parse_book(str(path), "epub")
    assert result.title == "Silo"
    assert result.author == "Hugh Howey"
    assert any("dark night" in c.text for c in result.chapters)


def test_epub_chapter_word_count(tmp_path):
    from ebooklib import epub

    book = epub.EpubBook()
    book.set_title("Test")
    book.add_author("Author")
    c1 = epub.EpubHtml(title="Ch1", file_name="c1.xhtml")
    c1.content = b"<p>one two three four five.</p>"
    book.add_item(c1)
    book.spine = ["nav", c1]
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    path = tmp_path / "test.epub"
    epub.write_epub(str(path), book)
    result = parse_book(str(path), "epub")
    assert result.chapters[0].word_count >= 5


def test_fb2_em_dash_text_extracted(tmp_path):
    fb2 = """<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
 <description><title-info>
   <book-title>Test FB2</book-title>
   <author><first-name>Ivan</first-name><last-name>Petrov</last-name></author>
 </title-info></description>
 <body><section><title><p>Chapter 1</p></title>
   <p>— Hello, said the man.</p></section></body>
</FictionBook>"""
    p = tmp_path / "t.fb2"
    p.write_text(fb2, encoding="utf-8")
    result = parse_book(str(p), "fb2")
    assert result.title == "Test FB2"
    assert "Hello" in result.chapters[0].text


def test_fb2_author_combined(tmp_path):
    fb2 = """<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
 <description><title-info>
   <book-title>My Novel</book-title>
   <author><first-name>Jane</first-name><last-name>Doe</last-name></author>
 </title-info></description>
 <body><section><p>Hello world.</p></section></body>
</FictionBook>"""
    p = tmp_path / "novel.fb2"
    p.write_text(fb2, encoding="utf-8")
    result = parse_book(str(p), "fb2")
    assert result.author == "Jane Doe"


def test_fb2_multiple_sections(tmp_path):
    fb2 = """<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
 <description><title-info>
   <book-title>Multi</book-title>
   <author><first-name>A</first-name><last-name>B</last-name></author>
 </title-info></description>
 <body>
   <section><title><p>Part 1</p></title><p>First section text.</p></section>
   <section><title><p>Part 2</p></title><p>Second section text.</p></section>
 </body>
</FictionBook>"""
    p = tmp_path / "multi.fb2"
    p.write_text(fb2, encoding="utf-8")
    result = parse_book(str(p), "fb2")
    assert len(result.chapters) == 2


def test_pdf_best_effort(tmp_path):
    """Build a one-page PDF with fitz and verify text is extracted and de-hyphenated."""
    import fitz

    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "CHAPTER ONE\n\nThis is an exam-\nple sentence.", fontsize=12)
    pdf_path = tmp_path / "test.pdf"
    doc.save(str(pdf_path))
    doc.close()

    result = parse_book(str(pdf_path), "pdf")
    assert isinstance(result, ParsedBook)
    # De-hyphenation: "exam-\nple" -> "example"
    full_text = " ".join(c.text for c in result.chapters)
    assert "example" in full_text


def test_pdf_empty_scanned_does_not_crash(tmp_path):
    """An image-only PDF with no text layer should not crash — return empty chapters."""
    import fitz

    doc = fitz.open()
    doc.new_page()  # blank page, no text
    pdf_path = tmp_path / "blank.pdf"
    doc.save(str(pdf_path))
    doc.close()

    # Must not raise
    result = parse_book(str(pdf_path), "pdf")
    assert isinstance(result, ParsedBook)
    assert result.source_format == "pdf"


def test_corrupt_file_raises(tmp_path):
    p = tmp_path / "bad.epub"
    p.write_bytes(b"not a zip")
    with pytest.raises(IngestionError):
        parse_book(str(p), "epub")


def test_unsupported_format_raises(tmp_path):
    p = tmp_path / "book.doc"
    p.write_bytes(b"some data")
    with pytest.raises(IngestionError, match="Unsupported"):
        parse_book(str(p), "doc")


def test_format_with_dot_prefix(tmp_path):
    """Format string may include leading dot (e.g. '.txt')."""
    p = tmp_path / "book.txt"
    p.write_text("Hello world.", encoding="utf-8")
    result = parse_book(str(p), ".txt")
    assert isinstance(result, ParsedBook)


def test_txt_no_chapter_headings_single_chapter(tmp_path):
    """A TXT file with no chapter headings should produce at least one chapter."""
    p = tmp_path / "prose.txt"
    p.write_text("Just some prose without headings.", encoding="utf-8")
    result = parse_book(str(p), "txt")
    assert len(result.chapters) >= 1
    assert "prose" in result.chapters[0].text
