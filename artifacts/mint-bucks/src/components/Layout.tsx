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
import { LogOut } from "lucide-react";
import { useClerk, useUser } from "@clerk/react";
import { useGetAuthMe } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import logoSrc from "@assets/MINT_Scripty_1782772632177.png";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

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
  const { signOut } = useClerk();
  const { user } = useUser();
  const { data: auth } = useGetAuthMe();

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar — collapses to an icon rail on small screens */}
      <aside className="w-14 md:w-56 flex-shrink-0 bg-sidebar flex flex-col">
        {/* Logo */}
        <div className="px-2 md:px-4 py-4 border-b border-sidebar-border flex items-center justify-center">
          <img src={logoSrc} alt="Mint Printworks" className="w-10 md:w-32 h-auto" />
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-2 md:px-3 py-4 space-y-0.5">
          {navItems.map(({ href, label, icon: Icon }) => {
            const isActive = href === "/" ? location === "/" : location.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                title={label}
                data-testid={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
                className={cn(
                  "flex items-center justify-center md:justify-start gap-3 px-2 md:px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="hidden md:inline">{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="px-2 md:px-5 py-4 border-t border-sidebar-border">
          <p className="hidden md:block text-sidebar-primary font-display text-base leading-none">Look fresh. Be happy.</p>
          <p className="hidden md:block text-sidebar-foreground/30 text-[10px] uppercase tracking-widest mt-1.5">Staff Portal</p>
          {user && (
            <div className="flex flex-col items-center md:items-start mt-3">
              <p
                className="hidden md:block text-sidebar-foreground/60 text-xs w-full truncate"
                data-testid="text-staff-email"
                title={user.primaryEmailAddress?.emailAddress ?? undefined}
              >
                {user.primaryEmailAddress?.emailAddress ?? user.fullName}
              </p>
              {auth?.role && (
                <span className="hidden md:inline-block mt-1 px-1.5 py-0.5 rounded bg-sidebar-accent/50 text-sidebar-foreground/70 text-[9px] uppercase tracking-widest font-semibold">
                  {auth.role}
                </span>
              )}
            </div>
          )}
          <button
            type="button"
            data-testid="button-sign-out"
            onClick={() => signOut({ redirectUrl: basePath || "/" })}
            className="mt-2 flex w-full items-center justify-center md:justify-start gap-2 rounded-md px-2 md:px-0 py-1.5 text-xs font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Sign out</span>
          </button>
        </div>
      </aside>

      {/* Main content — min-w-0 so wide tables scroll inside instead of stretching the page */}
      <main className="flex-1 min-w-0 overflow-auto">
        {children}
      </main>
    </div>
  );
}
