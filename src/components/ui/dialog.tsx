import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export function DialogContent({ className, overlayClassName, showOverlay = true, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content> & { overlayClassName?: string; showOverlay?: boolean }) {
  return <DialogPrimitive.Portal>{showOverlay && <DialogPrimitive.Overlay className={cn("fixed inset-0 z-40 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in", overlayClassName)} />}<DialogPrimitive.Content className={cn("fixed top-1/2 left-1/2 z-50 w-[min(92vw,600px)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-2xl focus:outline-none", className)} {...props}>{children}<DialogPrimitive.Close className="absolute right-5 top-5 text-muted-foreground hover:text-foreground" aria-label="Close"><X size={17} /></DialogPrimitive.Close></DialogPrimitive.Content></DialogPrimitive.Portal>;
}
