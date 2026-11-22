"use client";

import { HistoryIcon, HouseIcon, LogOutIcon, PlugIcon, SettingsIcon, MenuIcon, MoonIcon, SunIcon, WorkflowIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useState } from "react";
import { toast } from "sonner";
import { Logo } from "@/components/brand";
import { WorkspaceSwitcher, type WorkspaceOption } from "@/components/workspace-switcher";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { authClient } from "@/lib/auth-client";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

// Only sections that exist are listed. New sections are added as they ship.
const NAV = [
  { href: "/app/home", label: "Home", icon: HouseIcon },
  { href: "/app/workflows", label: "Workflows", icon: WorkflowIcon },
  { href: "/app/executions", label: "Runs", icon: HistoryIcon },
  { href: "/app/connections", label: "Connected apps", icon: PlugIcon },
  { href: "/app/settings", label: "Team & settings", icon: SettingsIcon },
];

interface ShellUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="grid gap-1">
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
              active
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            )}
          >
            <item.icon className="size-4" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function UserMenu({ user, compact = false }: { user: ShellUser; compact?: boolean }) {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const display = user.name?.trim() || user.email;

  async function signOut() {
    const { error } = await authClient.signOut();
    if (error) {
      toast.error("Could not sign out. Try again.");
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className={cn("h-auto justify-start gap-2.5 px-2 py-1.5", compact ? "w-auto" : "w-full")}
            aria-label="Account menu"
          />
        }
      >
        <Avatar className="size-7">
          {user.image && <AvatarImage src={user.image} alt="" />}
          <AvatarFallback className="text-[11px]">{initials(display)}</AvatarFallback>
        </Avatar>
        {!compact && (
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-sm font-medium">{display}</span>
            {user.name && <span className="block truncate text-xs text-muted-foreground">{user.email}</span>}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={compact ? "end" : "start"} side={compact ? "bottom" : "top"} className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">{user.email}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
          {resolvedTheme === "dark" ? <SunIcon /> : <MoonIcon />}
          {resolvedTheme === "dark" ? "Light theme" : "Dark theme"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({
  user,
  workspaceName,
  workspaces,
  currentWorkspaceId,
  children,
}: {
  user: ShellUser;
  workspaceName: string;
  workspaces: WorkspaceOption[];
  currentWorkspaceId: string;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-sidebar px-3 py-4 md:flex">
        <div className="px-2">
          <Logo href="/app/workflows" />
        </div>
        <div className="mt-3">
          <WorkspaceSwitcher workspaces={workspaces} currentId={currentWorkspaceId} />
        </div>
        <div className="mt-6 flex-1">
          <NavLinks />
        </div>
        <UserMenu user={user} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/80 px-4 py-2.5 backdrop-blur md:hidden">
          <Button variant="ghost" size="icon-sm" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>
            <MenuIcon />
          </Button>
          <Logo href="/app/workflows" />
          <UserMenu user={user} compact />
        </header>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-72 bg-sidebar p-4">
            <SheetHeader className="p-0">
              <SheetTitle className="text-left">
                <span className="text-sm text-muted-foreground">{workspaceName}</span>
              </SheetTitle>
            </SheetHeader>
            <div className="mt-3">
              <WorkspaceSwitcher workspaces={workspaces} currentId={currentWorkspaceId} />
            </div>
            <div className="mt-4">
              <NavLinks onNavigate={() => setMobileOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
