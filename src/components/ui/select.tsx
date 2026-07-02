import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends Omit<React.ComponentProps<"select">, "children"> {
  options: SelectOption[];
  /** Shown as a disabled first option; the field is "unset" while its value is "". */
  placeholder?: string;
}

// A styled native <select>. Native is deliberate here: it is fully keyboard- and
// screen-reader-accessible, needs no portal (so it can't clip inside a dialog's scroll
// area), and adds no dependency. The closed control is styled to match `Input`; the open
// list is rendered by the OS.
function Select({ className, options, placeholder, value, ...props }: SelectProps) {
  const isUnset = value === "" || value === undefined;
  return (
    <div className="relative w-full min-w-0">
      <select
        data-slot="select"
        value={value}
        className={cn(
          "border-input dark:bg-input/30 flex h-9 w-full min-w-0 appearance-none rounded-md border bg-transparent pl-3 pr-8 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
          isUnset && "text-muted-foreground",
          className
        )}
        {...props}
      >
        {placeholder !== undefined && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="text-muted-foreground pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2" />
    </div>
  );
}

export { Select };
