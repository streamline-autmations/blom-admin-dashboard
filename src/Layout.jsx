
import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { createPageUrl } from "@/utils";
import { ToastProvider } from "./components/ui/ToastProvider";
import { useNotifications } from "@/contexts/NotificationContext";
import {
  // Replaced Home
  Package,
  Layers,
  Sparkles,
  // Added
  ShoppingCart,
  FileText,
  // Replaced Warehouse
  MessageSquare,
  Star,
  Users,
  BarChart3,
  // Added
  // Added
  ChevronDown,
  ChevronRight,
  X,
  Sun,
  Moon,
  // Added
  // Added
  // Added
  Menu,
  // Added for mobile hamburger menu
  BookOpen, // Added for Course Bookings
  Handshake // Added for Affiliates
} from "lucide-react";



const navigationGroups = [
  {
    title: "Merchandising",
    items: [
      { name: "Products", url: "Products", icon: Package },
      { name: "Courses", url: "Courses", icon: BookOpen },
      { name: "Bundles", url: "Bundles", icon: Layers }
    ]
  },
  {
    title: "Sales & Inventory",
    items: [
      { name: "Orders", url: "Orders", icon: ShoppingCart },
      { name: "Create In-Store Invoice", url: "in-store-invoices", icon: FileText },
      { name: "Course Bookings", url: "course-bookings", icon: BookOpen },
      // { name: "Stock", url: "Stock", icon: Archive } // Changed from Warehouse to Archive
    ]
  },
  {
    title: "Engage & Marketing",
    items: [
      { name: "Reviews", url: "Reviews", icon: Star },
      { name: "Messages", url: "Messages", icon: MessageSquare },
      { name: "Contacts", url: "Contacts", icon: Users },
      { name: "Affiliates", url: "affiliates", icon: Handshake }
    ]
  },
  {
    title: "Analytics",
    items: [
      { name: "Analytics", url: "Analytics", icon: BarChart3 }
    ]
  }
];

function NavGroup({ group, currentPath, isCollapsed, onNavClick }) {
  const [isOpen, setIsOpen] = useState(true);
  const { counts } = useNotifications();

  const getBadgeCount = (url) => {
    // Debug logging
    // console.log('Checking badge for:', url, counts);
    if (url === 'Orders') return counts?.orders || 0;
    if (url === 'course-bookings') return counts?.course_bookings || 0;
    if (url === 'Messages') return counts?.messages || 0;
    if (url === 'Reviews') return counts?.reviews || 0;
    return 0;
  };

  return (
    <div className="nav-group">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="nav-group-header"
      >
        {!isCollapsed && (
          <>
            <span>{group.title}</span>
            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </>
        )}
      </button>
      {isOpen && (
        <div className="nav-items">
          {group.items.map(item => {
            const count = getBadgeCount(item.url);
            return (
              <Link
                key={item.url}
                to={item.url === "Orders" ? "/orders" : item.url === "featured" ? "/featured" : createPageUrl(item.url)}
                className={`nav-item ${currentPath.includes(item.url.toLowerCase()) ? 'active' : ''}`}
                onClick={onNavClick}
              >
                <div className="relative">
                  <item.icon className={isCollapsed ? "w-6 h-6" : "w-5 h-5"} />
                  {count > 0 && (
                    <span className="absolute -top-2 -right-2 bg-[#E02424] text-white text-[10px] font-bold h-[18px] min-w-[18px] flex items-center justify-center rounded-full border-2 border-[var(--bg)]">
                      {count > 99 ? '99+' : count}
                    </span>
                  )}
                </div>
                {!isCollapsed && (
                  <span className="flex-1 flex justify-between items-center">
                    {item.name}
                    {count > 0 && (
                      <span className="bg-[#E02424] text-white text-xs font-bold h-5 min-w-[20px] px-1.5 flex items-center justify-center rounded-full">
                        {count > 99 ? '99+' : count}
                      </span>
                    )}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatPageName(pathname) {
  if (pathname === '/' || pathname === '/dashboard') return 'Dashboard';
  const segment = pathname.split('/').filter(Boolean)[0] || 'dashboard';
  return segment
    .replace(/-/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function Layout({ children, currentPageName }) {
  const location = useLocation();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState('dark');

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    setTheme(savedTheme);
    document.documentElement.setAttribute('data-theme', savedTheme);
    document.documentElement.classList.toggle('dark', savedTheme === 'dark');
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
    document.documentElement.classList.toggle('dark', newTheme === 'dark');
  };

  return (
    <ToastProvider>
      <style>{`
        :root {
          --bg: hsl(var(--background));
          --card: hsl(var(--card));
          --text: hsl(var(--foreground));
          --text-muted: hsl(var(--muted-foreground));
          --border: hsl(var(--border));
          --accent: hsl(var(--primary));
          --accent-2: hsl(var(--primary));
          --accent-foreground: hsl(var(--primary-foreground));
          --hover-bg: hsl(var(--secondary));
          /* Backward-compat shim: pages not yet migrated off the old neumorphic
             dual-shadow pattern still reference these two vars. Tuned so the
             existing "6px 6px 12px var(--shadow-dark), -6px -6px 12px var(--shadow-light)"
             declarations collapse into one subtle flat elevation shadow instead
             of the old embossed look, until each page gets its own pass. */
          --shadow-dark: rgba(0, 0, 0, 0.08);
          --shadow-light: rgba(0, 0, 0, 0);
        }

        .dark {
          --shadow-dark: rgba(0, 0, 0, 0.4);
        }

        * {
          transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
        }

        body {
          background: var(--bg);
          color: var(--text);
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        }

        .app-shell {
          display: flex;
          min-height: 100vh;
          background: var(--bg);
        }

        .sidebar {
          width: ${sidebarCollapsed ? '80px' : '240px'};
          background: var(--card);
          border-right: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          position: fixed;
          left: 0;
          top: 0;
          bottom: 0;
          z-index: 100;
          transition: width 0.3s ease, transform 0.3s ease;
        }

        .sidebar-header {
          padding: 24px 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid var(--border);
        }

        .logo {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 20px;
          font-weight: 700;
          color: var(--text);
        }

        .logo-icon {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          background: var(--accent);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--accent-foreground);
          flex-shrink: 0;
        }

        .sidebar-content {
          flex: 1;
          overflow-y: auto;
          padding: 16px 12px;
        }

        .nav-group {
          margin-bottom: 24px;
        }

        .nav-group-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          color: var(--text-muted);
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          background: none;
          border: none;
          width: 100%;
          cursor: pointer;
          transition: color 0.2s;
        }

        .nav-group-header:hover {
          color: var(--text);
        }

        .nav-items {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-top: 8px;
        }

        .nav-item {
          display: flex;
          align-items: center;
          justify-content: ${sidebarCollapsed ? 'center' : 'flex-start'};
          gap: 12px;
          padding: ${sidebarCollapsed ? '16px' : '12px 16px'};
          color: var(--text);
          text-decoration: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          position: relative;
          background: transparent;
          transition: background-color 0.15s ease, color 0.15s ease;
        }

        .nav-item:hover {
          background: var(--hover-bg);
        }

        .nav-item.active {
          background: var(--accent);
          color: var(--accent-foreground);
        }

        .nav-item.active::before {
          content: '';
          position: absolute;
          left: 0;
          top: 50%;
          transform: translateY(-50%);
          width: 3px;
          height: 60%;
          background: var(--accent-foreground);
          border-radius: 0 3px 3px 0;
        }

        .main-content {
          flex: 1;
          min-width: 0;
          margin-left: ${sidebarCollapsed ? '80px' : '240px'};
          transition: margin-left 0.3s ease;
          display: flex;
          flex-direction: column;
        }

        .topbar {
          height: 72px;
          background: var(--card);
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 32px;
          position: sticky;
          top: 0;
          z-index: 50;
        }

        .topbar-left {
          display: flex;
          align-items: center;
          gap: 16px;
        }

        .menu-button {
          min-width: 44px;
          min-height: 44px;
          width: 44px;
          height: 44px;
          border-radius: 8px;
          background: var(--card);
          border: 1px solid var(--border);
          color: var(--text);
          cursor: pointer;
          display: none;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .menu-button:hover {
          background: var(--hover-bg);
        }

        .menu-button.mobile-menu {
          display: none;
        }

        .menu-button.desktop-menu {
          display: flex;
        }

        @media (max-width: 768px) {
          .menu-button.mobile-menu {
            display: flex;
          }

          .menu-button.desktop-menu {
            display: none;
          }
        }

        .breadcrumb {
          font-size: 24px;
          font-weight: 700;
          color: var(--text);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .topbar-actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .theme-toggle {
          min-width: 44px;
          min-height: 44px;
          width: 44px;
          height: 44px;
          border-radius: 8px;
          background: var(--card);
          border: 1px solid var(--border);
          color: var(--text);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .theme-toggle:hover {
          background: var(--hover-bg);
        }

        .content-area {
          flex: 1;
          min-width: 0;
          padding: 32px;
          overflow-y: auto;
        }

        @media (max-width: 768px) {
          .sidebar {
            transform: translateX(${mobileOpen ? '0' : '-100%'});
            width: 280px;
            z-index: 150;
            box-shadow: ${mobileOpen ? '8px 0 24px rgba(0, 0, 0, 0.3)' : 'none'};
          }

          .main-content {
            margin-left: 0;
          }

          .topbar {
            padding: 0 12px;
            height: 64px;
          }

          .topbar-left {
            gap: 8px;
            flex: 1;
            min-width: 0;
          }

          .breadcrumb {
            font-size: 18px;
          }

          .content-area {
            padding: 16px;
          }

          .nav-item {
            min-height: 48px;
            padding: 12px 16px;
          }

          .nav-group-header {
            min-height: 44px;
          }
        }

        .mobile-overlay {
          display: none;
        }

        @media (max-width: 768px) {
          .mobile-overlay {
            display: ${mobileOpen ? 'block' : 'none'};
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.6);
            z-index: 140;
            backdrop-filter: blur(2px);
            pointer-events: ${mobileOpen ? 'auto' : 'none'};
          }
        }
      `}</style>

      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="logo">
              <div className="logo-icon">
                <Package className="w-5 h-5" />
              </div>
              {!sidebarCollapsed && <span>BLOM Admin</span>}
            </div>
          </div>
          
          <div className="sidebar-content">
            {navigationGroups.map(group => (
              <NavGroup
                key={group.title}
                group={group}
                currentPath={location.pathname}
                isCollapsed={sidebarCollapsed}
                onNavClick={() => setMobileOpen(false)}
              />
            ))}
          </div>
        </aside>

        <div className="mobile-overlay" onClick={() => setMobileOpen(false)} />

        <div className="main-content">
          <header className="topbar">
            <div className="topbar-left">
              {/* Mobile menu button - VISIBLE on mobile, HIDDEN on desktop */}
              <button className="menu-button mobile-menu" onClick={() => setMobileOpen(!mobileOpen)}>
                {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>

              {/* Desktop collapse button - HIDDEN on mobile, VISIBLE on desktop */}
              <button className="menu-button desktop-menu" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
                {sidebarCollapsed ? <ChevronRight className="w-5 h-5" /> : <X className="w-5 h-5" />}
              </button>

              <h1 className="breadcrumb">
                {currentPageName || formatPageName(location.pathname)}
              </h1>
            </div>

            <div className="topbar-actions">
              <Link to="/seed" className="theme-toggle" title="Seed Test Data">
                <Sparkles className="w-5 h-5" />
              </Link>
              <button className="theme-toggle" onClick={toggleTheme}>
                {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
            </div>
          </header>

          <main className="content-area">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              {children}
            </motion.div>
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
