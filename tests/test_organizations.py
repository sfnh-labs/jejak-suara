import json

import pytest

from jejak import db, organizations


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "jejak.db"
    db.init_db(path)
    c = db.connect(path)
    yield c
    c.close()


def _seed(tmp_path, body: str):
    p = tmp_path / "orgs.toml"
    p.write_text(body)
    return p


def _figure(conn, fid, positions):
    conn.execute("INSERT INTO figures (id, name, role, positions) VALUES (?, ?, '', ?)",
                 (fid, fid, json.dumps(positions)))


SEED = """
[[org]]
name = "Dewan Perwakilan Rakyat"
short = "DPR"
aliases = ["DPR RI"]
kind = "parlemen"

[[org]]
name = "Partai Gerakan Indonesia Raya"
short = "Gerindra"
aliases = ["Partai Gerindra", "DPP Partai Gerindra"]
kind = "partai"
"""


def test_the_shipped_seed_loads_and_names_each_spelling_once():
    rows = organizations.load_seed()
    spellings = [organizations.fold(s) for r in rows for s in [r["name"], r["short"], *r["aliases"]] if s]
    dupes = {s for s in spellings if spellings.count(s) > 1}
    assert not dupes, dupes


def test_seed_adds_missing_and_keeps_the_curators_edits(conn, tmp_path):
    conn.execute("INSERT INTO organizations (name, short_name, updated_at) VALUES ('Dewan Perwakilan Rakyat', 'DPR-RI', 'x')")
    out = organizations.seed(conn, _seed(tmp_path, SEED))
    assert out == {"added": 1, "filled": 1}
    dpr = conn.execute("SELECT short_name, aliases, kind FROM organizations WHERE name = 'Dewan Perwakilan Rakyat'").fetchone()
    # The curator's short name stays; the empty aliases and kind are filled.
    assert (dpr["short_name"], json.loads(dpr["aliases"]), dpr["kind"]) == ("DPR-RI", ["DPR RI"], "parlemen")
    assert organizations.seed(conn, _seed(tmp_path, SEED)) == {"added": 0, "filled": 0}


def test_link_matches_name_short_name_and_alias_whatever_the_spelling(conn, tmp_path):
    organizations.seed(conn, _seed(tmp_path, SEED))
    _figure(conn, "a", [{"role": "Ketua", "org": "dpr  ri", "period": ""},
                        {"role": "Anggota", "org": "Partai Gerindra", "period": ""},
                        {"role": "Caleg", "org": "Pemilu 2024", "period": ""}])
    out = organizations.link(conn)
    assert out == {"linked": 2, "unlinked": 1, "figures_changed": 1}
    pos = json.loads(conn.execute("SELECT positions FROM figures WHERE id = 'a'").fetchone()[0])
    ids = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM organizations")}
    assert pos[0]["org_id"] == ids["Dewan Perwakilan Rakyat"]
    assert pos[1]["org_id"] == ids["Partai Gerakan Indonesia Raya"]
    assert "org_id" not in pos[2]
    # The CV's own words are kept.
    assert [p["org"] for p in pos] == ["dpr  ri", "Partai Gerindra", "Pemilu 2024"]
    assert organizations.link(conn)["figures_changed"] == 0
    assert organizations.unlinked(conn) == [("Pemilu 2024", 1)]


def test_link_drops_an_org_id_that_no_longer_matches(conn, tmp_path):
    organizations.seed(conn, _seed(tmp_path, SEED))
    _figure(conn, "b", [{"role": "Ketua", "org": "Komisi IV", "period": "", "org_id": 1}])
    organizations.link(conn)
    pos = json.loads(conn.execute("SELECT positions FROM figures WHERE id = 'b'").fetchone()[0])
    assert "org_id" not in pos[0]


def test_an_unknown_kind_in_the_seed_is_refused(tmp_path):
    with pytest.raises(ValueError):
        organizations.load_seed(_seed(tmp_path, '[[org]]\nname = "X"\nkind = "klub"\n'))
