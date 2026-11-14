"""A name counts only as a whole word, and a bare first or last name only for
someone the article has named in full."""
from jejak import cluster, ingest, quotes
from jejak.config import Figure

ARIES = Figure(id="aries", name="Aries Syahbudin", role="", aliases=["Aries"])


def test_a_name_inside_a_longer_word_is_no_mention():
    assert ingest._attribute("TEP Unpad perkuat kesehatan gigi anak cegah karies di Tomage", [ARIES]) is None
    assert ingest._attribute("Aries tinjau arus mudik di Cikampek", [ARIES]).id == "aries"
    assert ARIES.first_named_at("Kakorlantas Irjen Aries Syahbudin.") == 18
    assert ARIES.first_named_at("Kariesnya parah") is None


def test_related_figures_are_whole_words_too(monkeypatch):
    monkeypatch.setattr(cluster, "load_figures", lambda: [ARIES])
    assert cluster._figures_mentioned("Edukasi pencegahan karies gigi anak") == []
    assert cluster._figures_mentioned("Aries memimpin rapat") == ["aries"]


def _fig(fid, name, aliases=()):
    return quotes.Fig(fid, name, quotes._terms(name, list(aliases)), frozenset({name, *aliases}))


SITI = _fig("titiek", "Siti Hediati Hariyadi")
IFTITAH = _fig("iftitah", "Iftitah Suryanagara", ["Iftitah Suryanagara"])
JOKOWI = _fig("jokowi", "Joko Widodo", ["Jokowi"])
BAHLIL = _fig("bahlil", "Bahlil Lahadalia")


def test_a_first_name_alone_is_someone_the_article_named_in_full():
    body = ("Salah satu orang tua, Siti Qiptia, mengaku terbantu. \"Alhamdulillah,\" ungkap Siti. "
            "Menteri Transmigrasi Muhammad Iftitah Sulaiman Suryanagara menekankan solusi. "
            "\"Tinggalkan manfaat,\" ujar Iftitah.")
    assert quotes.match_speaker("Siti", [SITI, IFTITAH], body=body) is None
    # Every word of his name is there, if not side by side.
    assert quotes.match_speaker("Iftitah", [SITI, IFTITAH], body=body) == "iftitah"
    assert quotes.match_speaker("Siti", [SITI], body="Ketua MPR Siti Hediati Hariyadi hadir. Kata Siti.") == "titiek"


def test_a_first_name_going_on_with_another_name_is_someone_else():
    body = "Presiden Joko Widodo meresmikan. Kasat Lantas Kompol Joko Sembodo mengatur arus."
    assert quotes.match_speaker("Kasat Lantas Kompol Joko Sembodo", [JOKOWI], body=body) is None
    assert quotes.match_speaker("Presiden Joko Widodo", [JOKOWI], body=body) == "jokowi"
    assert quotes.match_speaker("Bahlil Lahadalia", [BAHLIL], body="Menteri Bahlil Lahadalia") == "bahlil"


def test_a_full_name_or_alias_needs_no_more():
    assert quotes.match_speaker("Jokowi", [JOKOWI], body="Kata Jokowi di Solo.") == "jokowi"
    assert quotes.match_speaker("Iftitah Suryanagara", [IFTITAH], body="") == "iftitah"
