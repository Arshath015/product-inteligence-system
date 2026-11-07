"use client";

const URL_PATTERN = /(https?:\/\/[^\s)]+)/g;

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    let label = u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "");
    if (label.length > 38) label = `${label.slice(0, 35)}…`;
    return label;
  } catch {
    return url.length > 40 ? `${url.slice(0, 37)}…` : url;
  }
}

/** Renders chat text with any raw URLs replaced by short, clickable links instead of the full string. */
export function LinkifiedText({ text, isUser = false }: { text: string; isUser?: boolean }) {
  const parts = text.split(URL_PATTERN);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className={`break-all underline decoration-dotted underline-offset-2 hover:decoration-solid ${
              isUser ? "text-accent-foreground" : "text-accent"
            }`}
          >
            {shortenUrl(part)}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
