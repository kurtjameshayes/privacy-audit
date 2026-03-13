import { useEffect } from "react";
import { Outlet, NavLink, useLocation } from "react-router-dom";
import {
  RefreshCw,
  Library,
  ShieldCheck,
  Clock,
  FileText,
  Lightbulb,
  GitBranchPlus,
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
  { to: "/consumer-rights", label: "Rights Router", desc: "DSR decision trees by state", icon: GitBranchPlus },
  { to: "/advisor", label: "Policy Advisor", desc: "AI-suggested rewrites to close gaps", icon: Lightbulb },
  { to: "/runs", label: "Run History", desc: "Review past analysis results", icon: Clock },
  { to: "/reports", label: "Reports", desc: "Generate compliance summaries", icon: FileText },
];

export default function Layout() {
  const location = useLocation();

  useEffect(() => {
    const aside = document.querySelector("aside");
    const computed = aside ? window.getComputedStyle(aside) : null;
    // #region agent log
    fetch("http://127.0.0.1:7513/ingest/ca35bdd0-a85e-4f3f-8fa2-3df702c131ad",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"547d10"},body:JSON.stringify({sessionId:"547d10",runId:"pre-fix-1",hypothesisId:"H3",location:"frontend/src/components/Layout.tsx:35",message:"layout mount computed style snapshot",data:{path:location.pathname,asideFound:Boolean(aside),asideBg:computed?.backgroundColor||null,asideWidth:computed?.width||null,bodyClass:document.body.className,styleSheetCount:document.styleSheets.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    // #region agent log
    fetch("http://127.0.0.1:7513/ingest/ca35bdd0-a85e-4f3f-8fa2-3df702c131ad",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"547d10"},body:JSON.stringify({sessionId:"547d10",runId:"pre-fix-1",hypothesisId:"H4",location:"frontend/src/components/Layout.tsx:38",message:"asset urls observed in DOM",data:{styleLinks:Array.from(document.querySelectorAll('link[rel=\"stylesheet\"]')).map((l)=>l.getAttribute("href")),moduleScripts:Array.from(document.querySelectorAll('script[type=\"module\"]')).map((s)=>s.getAttribute("src"))},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }, [location.pathname]);

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
