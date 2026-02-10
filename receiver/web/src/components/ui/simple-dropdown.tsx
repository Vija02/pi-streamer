import * as React from "react"
import { cn } from "@/lib/utils"

interface SimpleDropdownProps {
  trigger: React.ReactNode
  children: React.ReactNode
  align?: "start" | "end"
  disabled?: boolean
}

export function SimpleDropdown({ trigger, children, align = "start", disabled }: SimpleDropdownProps) {
  const [open, setOpen] = React.useState(false)
  const dropdownRef = React.useRef<HTMLDivElement>(null)

  // Close on click outside
  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    if (open) {
      document.addEventListener("mousedown", handleClickOutside)
      return () => document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [open])

  // Close on escape
  React.useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false)
      }
    }

    if (open) {
      document.addEventListener("keydown", handleEscape)
      return () => document.removeEventListener("keydown", handleEscape)
    }
  }, [open])

  return (
    <div className="relative inline-block" ref={dropdownRef}>
      <div onClick={() => !disabled && setOpen(!open)}>
        {trigger}
      </div>
      {open && (
        <div
          className={cn(
            "absolute z-50 mt-1 min-w-[8rem] overflow-hidden rounded-md border border-slate-600 bg-slate-800 p-1 text-slate-200 shadow-lg",
            align === "end" ? "right-0" : "left-0"
          )}
        >
          {children}
        </div>
      )}
    </div>
  )
}

interface SimpleDropdownItemProps {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  asChild?: boolean
  className?: string
}

export function SimpleDropdownItem({ children, onClick, disabled, className }: SimpleDropdownItemProps) {
  return (
    <div
      onClick={() => !disabled && onClick?.()}
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
        "hover:bg-slate-700",
        disabled && "pointer-events-none opacity-50",
        className
      )}
    >
      {children}
    </div>
  )
}
