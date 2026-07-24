// Mobile-only slim top bar: Back + page title + Search + Settings.
// Hidden on desktop (CSS display:none unless ≤768px) where the left sidebar
// already has these. On phone the sidebar collapses to a bottom dock of nav
// tabs, so Back/Search/Settings need a reachable home — this is it. Settings
// in particular was stranded on mobile (hidden in .sidebar-bottom with no
// replacement).
import { BackIcon, SearchIcon, SettingsIcon } from "./Icons";

const TITLES = {
  home: "Home",
  discover: "Discover",
  together: "Watch Together",
  history: "Library",
  downloads: "Downloads",
  settings: "Settings",
};

export default function MobileTopBar({ page, canGoBack, onBack, onSearch, onSettings }) {
  return (
    <div className="mobile-topbar">
      <button
        className="mobile-topbar-btn"
        onClick={onBack}
        disabled={!canGoBack}
        aria-label="Back"
      >
        <BackIcon />
      </button>
      <div className="mobile-topbar-title">{TITLES[page] || ""}</div>
      <button className="mobile-topbar-btn" onClick={onSearch} aria-label="Search">
        <SearchIcon />
      </button>
      <button className="mobile-topbar-btn" onClick={onSettings} aria-label="Settings">
        <SettingsIcon />
      </button>
    </div>
  );
}
