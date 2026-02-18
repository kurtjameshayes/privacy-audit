import { Outlet, NavLink } from "react-router-dom";

const navItems = [
  { to: "/gather", label: "Gather" },
  { to: "/policies", label: "Documents" },
  { to: "/compliance", label: "Compliance" },
  { to: "/alerts", label: "Alerts" },
  { to: "/runs", label: "Runs" },
  { to: "/reports", label: "Reports" },
] as const;

export default function Layout() {
  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-topbar-left">
          <div className="app-logo">PA</div>
          <div className="app-brand">
            <span className="app-brand-name">Privacy Audit Studio</span>
            <span className="app-brand-tagline">Policy Intelligence Lab</span>
          </div>
        </div>
        <nav className="app-topbar-nav">
          {navItems.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `app-topbar-nav-item ${isActive ? "is-active" : ""}`
              }
              end={to === "/"}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="app-topbar-right">
          <span className="app-topbar-meta">Policy Vault</span>
          <span className="app-topbar-meta-divider">·</span>
          <span className="app-topbar-meta">Gather → Index → Compare</span>
        </div>
      </header>
      <div className="app-subbar">
        <span className="app-subbar-text">
          Gather, index, and compare privacy policies with statutory and industry
          standards.
        </span>
      </div>
      <main className="main-panel">
        <div className="main-panel-inner">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
