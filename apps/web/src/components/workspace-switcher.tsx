"use client";

import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronsUpDownIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface WorkspaceOption {
  id: string;
  name: string;
  role: string;
  plan: string;
}

async function post(path: string, body: unknown) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? "Something went wrong. Please try again.");
  return data;
}

/** Switches the workspace everything in the app works in. */
export function WorkspaceSwitcher({ workspaces, currentId }: { workspaces: WorkspaceOption[]; currentId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const current = workspaces.find((w) => w.id === currentId);

  async function switchTo(id: string) {
    if (id === currentId) return;
    try {
      await post("/api/workspaces/switch", { workspaceId: id });
      qc.clear(); // cached lists belong to the old workspace
      router.push("/app/workflows");
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" className="h-auto w-full justify-between gap-2 px-2 py-1.5" aria-label="Switch workspace" />}>
          <span className="min-w-0 text-left">
            <span className="block truncate text-sm font-medium">{current?.name ?? "Workspace"}</span>
            <span className="block truncate text-xs text-muted-foreground capitalize">
              {current ? `${current.plan} plan · ${current.role}` : ""}
            </span>
          </span>
          <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            {workspaces.map((w) => (
              <DropdownMenuItem key={w.id} onClick={() => switchTo(w.id)}>
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                {w.id === currentId && <CheckIcon aria-label="Current" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreating(true)}>
            <PlusIcon />
            Create a team
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-sm">{creating && <CreateTeamForm onClose={() => setCreating(false)} />}</DialogContent>
      </Dialog>
    </>
  );
}

function CreateTeamForm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        try {
          await post("/api/workspaces", { name });
          qc.clear();
          onClose();
          router.push("/app/settings");
          router.refresh();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setPending(false);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>Create a team</DialogTitle>
        <DialogDescription>A shared workspace with its own workflows, accounts, plan and credits. You can invite people next.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor="team-name">Team name</Label>
        <Input id="team-name" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Ops" />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !name.trim()}>
          {pending && <Loader2Icon className="animate-spin" />}
          Create team
        </Button>
      </DialogFooter>
    </form>
  );
}
