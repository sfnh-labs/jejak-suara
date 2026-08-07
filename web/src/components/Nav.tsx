import Link from "next/link";

const LINKS = [
  { href: "/", label: "Beranda" },
  { href: "/linimasa", label: "Linimasa" },
  { href: "/tentang", label: "Dukung Kami" },
];

export default function Nav({ active }: { active?: string }) {
  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 12,
        padding: "15px clamp(16px, 5vw, 48px)",
        background: "#f6f2e9",
        borderBottom: "1px solid #16130f",
      }}
    >
      <Link
        href="/"
        style={{
          fontFamily: "var(--font-serif)",
          fontWeight: 700,
          fontSize: 22,
          letterSpacing: "-0.01em",
          textDecoration: "none",
          color: "#16130f",
        }}
      >
        Jejak Suara
      </Link>
      <div style={{ display: "flex", gap: "clamp(14px, 3vw, 28px)", fontSize: 13, fontWeight: 600 }}>
        {LINKS.map((link) => {
          const isActive = active === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              style={{
                color: isActive ? "#16130f" : "#7a7264",
                textDecoration: "none",
                paddingBottom: 2,
                borderBottom: isActive ? "2px solid #8b2e1f" : "2px solid transparent",
              }}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
