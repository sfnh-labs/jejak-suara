"use client";

import { useId, useRef, useState } from "react";
import { MUTED, RULE, SURFACE, input } from "./ui";

type Org = { name: string; short: string; uses: number };

/** The organisations, read once from the page's OrgOptions list. */
function registry(listId: string): Org[] {
  const list = document.getElementById(listId);
  if (!list) return [];
  return [...list.querySelectorAll("option")].map((o) => ({
    name: o.value,
    short: o.dataset.short ?? "",
    uses: Number(o.dataset.uses ?? 0),
  }));
}

/** Case, accents and spacing aside; the same rule as lib/curation orgKey. */
function key(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function search(all: Org[], q: string, limit = 8): Org[] {
  const words = key(q).split(" ").filter(Boolean);
  if (!words.length) return all.slice(0, limit);
  const hits: { o: Org; score: number }[] = [];
  for (const o of all) {
    const name = key(o.name);
    const short = key(o.short);
    const hay = `${name} ${short}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const score = short === key(q) || name.startsWith(words[0]) || short.startsWith(words[0]) ? 0 : 1;
    hits.push({ o, score });
  }
  return hits.sort((a, b) => a.score - b.score || b.o.uses - a.o.uses).slice(0, limit).map((h) => h.o);
}

const NEED_CHOICE = "Pilih lembaga dari daftar, atau tambahkan sebagai lembaga baru.";

/**
 * The organisation of one office, picked from every organisation already
 * known (OrgOptions) so the same body is not typed twice under two
 * spellings. One not on the list has to be added on purpose, as "Lembaga
 * baru", and until then the form will not save. Exactly one `pos_org` field
 * per row at all times, so the office columns stay aligned. Without script
 * the box is a plain text field; the save still matches it to the list.
 */
export function OrgPicker({ listId, defaultValue, placeholder }: { listId: string; defaultValue: string; placeholder?: string }) {
  const [all, setAll] = useState<Org[] | null>(null);
  const [picked, setPicked] = useState<{ name: string; fresh: boolean } | null>(defaultValue ? { name: defaultValue, fresh: false } : null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const orgs = all ?? [];
  const load = () => {
    if (!all) setAll(registry(listId));
  };
  const hits = all ? search(orgs, q) : [];
  const exact = q.trim() ? orgs.find((o) => key(o.name) === key(q) || (o.short && key(o.short) === key(q))) : undefined;
  // The last row adds what was typed as a new organisation, unless it is one.
  const offerNew = Boolean(q.trim()) && !exact;
  const rows = hits.length + (offerNew ? 1 : 0);

  const choose = (name: string, fresh: boolean) => {
    setPicked({ name, fresh });
    setQ("");
    setOpen(false);
    box.current?.setCustomValidity("");
  };
  const pickRow = (i: number) => {
    if (i < hits.length) choose(hits[i].name, false);
    else if (offerNew) choose(q.replace(/\s+/g, " ").trim(), true);
  };

  if (picked) {
    const known = orgs.find((o) => key(o.name) === key(picked.name));
    return (
      <div style={{ ...input, width: "100%", display: "flex", alignItems: "center", gap: 8, ...(picked.fresh ? { borderStyle: "dashed", borderColor: "var(--color-clay)" } : {}) }}>
        <input type="hidden" name="pos_org" value={picked.name} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {picked.name}
          <span style={{ color: picked.fresh ? "var(--color-clay)" : MUTED, fontSize: 11.5 }}>
            {picked.fresh ? " · lembaga baru" : known?.short ? ` · ${known.short}` : ""}
          </span>
        </span>
        <button
          type="button"
          onClick={() => {
            setPicked(null);
            setQ("");
            load();
            requestAnimationFrame(() => box.current?.focus());
          }}
          aria-label={`Ganti lembaga ${picked.name}`}
          style={{ border: "none", background: "none", color: MUTED, cursor: "pointer", fontSize: 12, padding: 0, textDecoration: "underline" }}
        >
          Ganti
        </button>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", display: "grid" }}>
      <input
        ref={box}
        name="pos_org"
        value={q}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-label="Lembaga"
        autoComplete="off"
        placeholder={placeholder ?? "Cari lembaga: nama atau singkatan"}
        onFocus={() => {
          load();
          setOpen(true);
        }}
        onBlur={(e) => {
          const el = e.currentTarget;
          setTimeout(() => {
            setOpen(false);
            // Typed but not chosen: one of the list, taken as is, else stop the save.
            const typed = el.value.trim();
            if (!typed) return el.setCustomValidity("");
            const match = registry(listId).find((o) => key(o.name) === key(typed) || (o.short && key(o.short) === key(typed)));
            if (match) choose(match.name, false);
            else el.setCustomValidity(NEED_CHOICE);
          }, 150);
        }}
        onChange={(e) => {
          load();
          e.currentTarget.setCustomValidity("");
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, rows - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && open && rows > 0) {
            e.preventDefault();
            pickRow(active);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        style={{ ...input, width: "100%" }}
      />
      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          style={{
            position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, margin: "2px 0 0", padding: 0, listStyle: "none",
            background: SURFACE, border: "1.5px solid var(--color-ink)", boxShadow: "4px 4px 0 var(--color-ink)", maxHeight: 300, overflowY: "auto",
          }}
        >
          {hits.map((o, i) => (
            <li
              key={o.name}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pickRow(i);
              }}
              onMouseEnter={() => setActive(i)}
              style={{ padding: "7px 10px", cursor: "pointer", borderTop: i ? `1px solid ${RULE}` : "none", background: i === active ? "var(--color-parchment)" : "transparent" }}
            >
              <div style={{ fontSize: 13 }}>
                {o.name}
                {o.short ? <span style={{ color: MUTED }}> · {o.short}</span> : null}
              </div>
              <div style={{ fontSize: 11.5, color: MUTED }}>{o.uses ? `dipakai ${o.uses} tokoh` : "di daftar organisasi"}</div>
            </li>
          ))}
          {offerNew ? (
            <li
              role="option"
              aria-selected={active === hits.length}
              onMouseDown={(e) => {
                e.preventDefault();
                pickRow(hits.length);
              }}
              onMouseEnter={() => setActive(hits.length)}
              style={{
                padding: "8px 10px", cursor: "pointer", borderTop: hits.length ? `1.5px solid var(--color-ink)` : "none",
                background: active === hits.length ? "var(--color-warn-bg)" : "transparent", color: "var(--color-clay)",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>+ Lembaga baru: “{q.trim()}”</div>
              <div style={{ fontSize: 11.5, color: MUTED }}>
                {hits.length ? "Pastikan bukan salah satu di atas dengan nama lain." : "Belum ada lembaga dengan nama ini."}
              </div>
            </li>
          ) : null}
          {!hits.length && !offerNew ? <li style={{ padding: "8px 10px", fontSize: 12.5, color: MUTED }}>Ketik nama atau singkatan lembaga.</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
