import { useEffect, useState } from "react";
import { Button } from "./components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog.js";

export type ConfirmOptions = {
  /** Dialog heading; defaults to "Are you sure?". */
  title?: string;
  /** Names the confirm button. When set, browsers get the in-page dialog too, since their own box can only say OK. */
  confirmLabel?: string;
  /** Styles the confirm button as destructive and focuses Cancel instead. */
  destructive?: boolean;
};

type Ask = ConfirmOptions & {
  message: string;
  resolve: (ok: boolean) => void;
};
let listener: ((ask: Ask) => void) | undefined;

/**
 * Ask before a risky action. Browsers use their own confirm box. The desktop app's webview
 * cannot show one (window.confirm silently returns false there), so it gets an in-page dialog,
 * as does any ask that names its confirm button.
 */
export function confirmAction(
  message: string,
  options: ConfirmOptions = {},
): Promise<boolean> {
  const inPage =
    "desktop" in document.documentElement.dataset || !!options.confirmLabel;
  if (!inPage || !listener) return Promise.resolve(window.confirm(message));
  return new Promise((resolve) => listener?.({ ...options, message, resolve }));
}

/** Mount once near the root; it shows the dialog that confirmAction opens in page. */
export function ConfirmHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  // The last ask stays rendered while the dialog animates closed.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    listener = (next) => {
      setAsk(next);
      setOpen(true);
    };
    return () => {
      listener = undefined;
    };
  }, []);
  const answer = (ok: boolean) => {
    if (!open) return;
    ask?.resolve(ok);
    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={(open) => !open && answer(false)}>
      <DialogContent className="w-[min(92vw,440px)]">
        <DialogTitle className="text-base font-semibold">
          {ask?.title ?? "Are you sure?"}
        </DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          {ask?.message}
        </DialogDescription>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="outline"
            autoFocus={!!ask?.destructive}
            onClick={() => answer(false)}
          >
            Cancel
          </Button>
          <Button
            autoFocus={!ask?.destructive}
            variant={ask?.destructive ? "destructive" : "default"}
            onClick={() => answer(true)}
          >
            {ask?.confirmLabel ?? "Continue"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
