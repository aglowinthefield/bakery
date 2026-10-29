import { useEffect, useState } from "react";
import { repoIcons } from "./repo-appearance.js";

const brandIcons: readonly string[] = repoIcons;

const storageKey = "bakery-icon";

function readIcon() {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved && brandIcons.includes(saved)) return saved;
  } catch {
    // Storage can be disabled. The default icon still renders.
  }
  return brandIcons[0];
}

// The picked icon is also the tab icon.
function setFavicon(icon: string) {
  document
    .querySelector<HTMLLinkElement>('link[rel="icon"]')
    ?.setAttribute("href", `/icons/${icon}.png`);
}

export function BrandIcon() {
  const [icon, setIcon] = useState(readIcon);
  const [open, setOpen] = useState(false);

  useEffect(() => setFavicon(icon), [icon]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) =>
      event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  function pick(next: string) {
    setIcon(next);
    setOpen(false);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // The choice lasts for this page load only.
    }
  }

  return (
    <div className="relative">
      <button
        aria-label="Change icon"
        title="Change icon"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="grid size-9 place-items-center rounded-lg border border-primary/20 bg-primary/10 hover:bg-primary/20"
      >
        <img
          src={`/icons/${icon}.png`}
          alt=""
          className="size-6 object-contain"
        />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-11 z-50 grid w-48 grid-cols-4 gap-1 rounded-lg border border-border bg-popover p-2 shadow-lg">
            {brandIcons.map((name) => (
              <button
                key={name}
                aria-label={name.replace(/_/g, " ")}
                title={name.replace(/_/g, " ")}
                onClick={() => pick(name)}
                className={`grid size-10 place-items-center rounded-md hover:bg-accent ${name === icon ? "bg-accent ring-1 ring-primary" : ""}`}
              >
                <img
                  src={`/icons/${name}.png`}
                  alt=""
                  className="size-7 object-contain"
                />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
