"use client";
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** Tema atual (o script inline em layout.tsx já aplicou `data-theme` antes da 1ª pintura). */
export function useDarkMode() {
  return useSyncExternalStore(subscribe, () => document.documentElement.getAttribute("data-theme") === "catworld-dark", () => false);
}
