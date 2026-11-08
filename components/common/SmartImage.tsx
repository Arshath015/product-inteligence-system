"use client";

import Image from "next/image";
import { useState } from "react";

/**
 * Wraps next/image (fill layout) with a loading skeleton and a one-shot
 * error fallback. Never retries automatically — a broken URL just shows
 * the fallback instead of a broken-image icon, and stays that way (no
 * retry loop against a permanently dead link).
 */
export function SmartImage({
  src,
  alt,
  className = "",
  fallback,
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  fallback: React.ReactNode;
}) {
  const [errored, setErrored] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (!src || errored) return <>{fallback}</>;

  return (
    <>
      {!loaded && <div className="absolute inset-0 animate-pulse bg-surface" />}
      <Image
        src={src}
        alt={alt}
        fill
        unoptimized
        className={`${className} transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
      />
    </>
  );
}
