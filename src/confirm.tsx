import { useEffect, useState } from "react";
import { Button } from "./components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog.js";

type Ask = { message: string; resolve: (ok: boolean) => void };
let listener: ((ask: Ask) => void) | undefined;

/**
 * Ask before a risky action. Browsers use their own confirm box. The desktop app's webview
 * cannot show one (window.confirm silently returns false there), so it gets an in-page dialog.
 */
export function confirmAction(message: string): Promise<boolean> {
  if (!("desktop" in document.documentElement.dataset) || !listener)
    return Promise.resolve(window.confirm(message));
  return new Promise((resolve) => listener?.({ message, resolve }));
}

/** Mount once near the root; it shows the dialog that confirmAction opens in the desktop app. */
export function ConfirmHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  useEffect(() => {
    listener = (next) => setAsk(next);
    return () => {
      listener = undefined;
    };
  }, []);
  const answer = (ok: boolean) => {
    ask?.resolve(ok);
    setAsk(null);
  };
  return (
    <Dialog open={!!ask} onOpenChange={(open) => !open && answer(false)}>
      <DialogContent className="w-[min(92vw,440px)]">
        <DialogTitle className="text-base font-semibold">
          Are you sure?
        </DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          {ask?.message}
        </DialogDescription>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button autoFocus onClick={() => answer(true)}>
            Continue
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
