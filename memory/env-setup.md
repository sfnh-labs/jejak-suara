---
name: env-setup
description: Windows env quirks for jejak-suara — python shim/PATH mismatch, UTF-8 console, API keys
metadata:
  type: project
---

Dev environment facts for jejak-suara on this Windows machine (set up 2026-06-13):

- **python/pip mismatch:** `python` on PATH resolves to the Windows Store shim
  (`...\WindowsApps\python.exe`), but pip installs into
  `C:\Users\Admin\AppData\Local\Python\pythoncore-3.14-64\`. Console scripts land in
  that interpreter's `Scripts\` dir. This is why `flask` was "installed but not found".
  That `Scripts\` dir was added to the **User** PATH to fix it. If other CLIs go
  missing, this mismatch is the root cause.
- **Console encoding:** Windows console defaults to cp1252 and crashes on the
  pipeline's non-ASCII (`●`, `⚠`, em-dash, Indonesian text). `jejak/cli.py` now forces
  stdout/stderr to UTF-8 at startup; for ad-hoc `python -c`/flask runs, set
  `$env:PYTHONIOENCODING = "utf-8"` first.
- **API keys** (both set persistently at **User** scope, not visible to an
  already-running shell — read via `[Environment]::GetEnvironmentVariable(name,"User")`):
  `ANTHROPIC_API_KEY` (summarize=Opus, sentiment classify=Haiku) and
  `YOUTUBE_API_KEY` (sentiment comment gathering). A valid YouTube key is 39 chars
  starting `AIza`.

See also [[sentiment-query-coverage]].
