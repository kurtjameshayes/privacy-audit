import { Outlet, NavLink } from "react-router-dom";
import {
  RefreshCw,
  Library,
  ShieldCheck,
  Clock,
  FileText,
  Lightbulb,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

const navItems: ReadonlyArray<{
  to: string;
  label: string;
  desc: string;
  icon: LucideIcon;
}> = [
  { to: "/gather", label: "Gather", desc: "Find and import privacy texts", icon: RefreshCw },
  { to: "/policies", label: "Documents", desc: "Library of policies and statutes", icon: Library },
  { to: "/compliance", label: "Compliance Analysis", desc: "Evaluate policy adherence", icon: ShieldCheck },
  { to: "/advisor", label: "Policy Advisor", desc: "AI-suggested rewrites to close gaps", icon: Lightbulb },
  { to: "/runs", label: "Run History", desc: "Review past analysis results", icon: Clock },
  { to: "/reports", label: "Reports", desc: "Generate compliance summaries", icon: FileText },
];

export default function Layout() {
  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <aside className="w-64 min-w-[256px] bg-slate-900 text-white flex flex-col">
        <div className="px-5 py-6">
          <h1 className="text-lg font-bold text-white leading-tight">
            Privacy Audit
            <br />
            Studio
          </h1>
        </div>

        <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
          {navItems.map(({ to, label, desc, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-start gap-3 px-3 py-3 rounded-lg text-sm transition-colors no-underline ${
                  isActive
                    ? "bg-indigo-600 text-white"
                    : "text-slate-400 hover:text-white hover:bg-slate-800"
                }`
              }
              end={to === "/"}
            >
              <Icon className="h-5 w-5 mt-0.5 flex-shrink-0" />
              <div>
                <span className="font-medium block">{label}</span>
                <span className="text-xs opacity-60">{desc}</span>
              </div>
            </NavLink>
          ))}
        </nav>

        <div className="px-5 py-4 border-t border-slate-700/50">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center text-white text-sm font-medium flex-shrink-0">
              PO
            </div>
            <span className="text-sm text-slate-300">Privacy Officer</span>
          </div>
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
