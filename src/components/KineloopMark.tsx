import { cn } from "@/lib/utils";
import markDark from "@/assets/kineloop-symbol-dark.png";
import markLight from "@/assets/kineloop-symbol-light.png";

/**
 * The Kineloop brand symbol — a looping "K" path with a blue accent node (the
 * supervising control point). Uses the polished symbol art directly; the white
 * variant shows on dark backgrounds and the black variant on light, swapped via
 * the `.dark` class Tailwind toggles on <html>.
 */
export function KineloopMark({ className }: { className?: string }) {
  return (
    <>
      <img
        src={markLight}
        alt="Kineloop"
        className={cn("shrink-0 object-contain dark:hidden", className)}
      />
      <img
        src={markDark}
        alt="Kineloop"
        aria-hidden
        className={cn("hidden shrink-0 object-contain dark:block", className)}
      />
    </>
  );
}
