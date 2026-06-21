import sqlite3
conn = sqlite3.connect("jejak.db")
cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in cur.fetchall()]
print("Tables:", tables)
for t in tables:
    count = conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
    print(f"  {t}: {count} rows")
conn.close()
