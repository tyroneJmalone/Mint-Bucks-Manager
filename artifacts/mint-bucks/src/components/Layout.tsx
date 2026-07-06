import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Users,
  CreditCard,
  ArrowDownLeft,
  Gift,
  BarChart3,
  FileText,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import logoSrc from "@assets/MINT_Scripty_1782772632177.png";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/credits", label: "Mint Bucks", icon: CreditCard },
  { href: "/redemptions", label: "Redemptions", icon: ArrowDownLeft },
  { href: "/rewards", label: "Rewards", icon: Gift },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/reports/certificates", label: "Cert. History", icon: FileText },
  { href: "/settings", label: "Settings", icon: Settings },
];

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-sidebar flex flex-col">
        {/* Logo */}
        <div className="px-4 py-4 border-b border-sidebar-border flex items-center justify-center">
          <img src={logoSrc} alt="Mint Printworks" className="w-32 h-auto" />
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {navItems.map(({ href, label, icon: Icon }) => {
            const isActive = href === "/" ? location === "/" : location.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                data-testid={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="px-5 py-4 border-t border-sidebar-border">
          <p className="text-sidebar-primary font-display text-base leading-none">Look fresh. Be happy.</p>
          <p className="text-sidebar-foreground/30 text-[10px] uppercase tracking-widest mt-1.5">Staff Portal</p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
