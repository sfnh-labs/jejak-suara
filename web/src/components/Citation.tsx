"use client";

import { useRef } from "react";

/**
 * A [n] citation linking to its article, with a tooltip naming it.
 *
 * Client-side only to keep the tooltip on screen: it is centred on the number,
 * and a number near either edge of a phone screen would push half of it out of
 * view. On hover or focus the tip is measured and nudged back inside.
 */
export default function Citation({
  label,
  href,
  title,
  meta,
  size,
}: {
  label: string;
  href: string;
  title: string;
  meta: string;
  size: number;
}) {
  const tip = useRef<HTMLSpanElement>(null);

  function keepOnScreen() {
    const el = tip.current;
    if (!el) return;
    el.style.setProperty("--shift", "0px");
    const r = el.getBoundingClientRect();
    const gutter = 8;
    const shift =
      r.left < gutter ? gutter - r.left
      : r.right > window.innerWidth - gutter ? window.innerWidth - gutter - r.right
      : 0;
    el.style.setProperty("--shift", `${shift}px`);
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="cite"
      style={{ fontSize: size }}
      onMouseEnter={keepOnScreen}
      onFocus={keepOnScreen}
    >
      {label}
      <span ref={tip} role="tooltip" className="cite-tip">
        {title}
        <span className="cite-tip-source">{meta}</span>
      </span>
    </a>
  );
}
