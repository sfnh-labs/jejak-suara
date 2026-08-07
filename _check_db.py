import sqlite3
conn = sqlite3.connect('jejak.db')
cur = conn.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = cur.fetchall()
for t in tables:
    cur.execute(f"PRAGMA table_info({t[0]})")
    cols = cur.fetchall()
    print(f"Table: {t[0]}")
    for c in cols:
        print(f"  {c[1]} ({c[2]})")
    cur.execute(f"SELECT COUNT(*) FROM {t[0]}")
    print(f"  Rows: {cur.fetchone()[0]}")
    print()
conn.close()
