import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

interface TooltipProps {
  content: string;
  children: React.ReactNode;
}

export function Tooltip({ content, children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({
        top: rect.top - 8,
        left: rect.left + rect.width / 2,
      });
    }
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <div
        ref={triggerRef}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {children}
      </div>
      {open &&
        content &&
        createPortal(
          <div
            className="fixed z-[9999] w-64 rounded-lg bg-slate-900 text-white text-xs leading-relaxed p-3 shadow-lg pointer-events-none -translate-x-1/2 -translate-y-full"
            style={{ top: position.top, left: position.left }}
          >
            {content}
            <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-900" />
          </div>,
          document.body
        )}
    </div>
  );
}

interface InfoIconProps {
  content: string;
}

export function InfoIcon({ content }: InfoIconProps) {
  return (
    <Tooltip content={content}>
      <Info className="h-4 w-4 text-slate-400 hover:text-slate-600 cursor-help transition-colors" />
    </Tooltip>
  );
}
