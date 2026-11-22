"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, MailIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { NativeSelect } from "@/components/editor/param-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { DeveloperSettings } from "./developer-settings";
import { SecuritySettings } from "./security-settings";
import { VariablesSettings } from "./variables-settings";

interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
}
interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}) } });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? "Something went wrong. Please try again.");
  return data as T;
}

const ROLE_HELP: Record<string, string> = {
  owner: "Everything, including owners",
  admin: "Members and all workflows",
  editor: "Build, run and publish workflows",
  viewer: "View workflows and runs",
};

export function SettingsView({
  workspace,
  me,
}: {
  workspace: { id: string; name: string; role: string; personal: boolean };
  me: string;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const manage = workspace.role === "owner" || workspace.role === "admin";
  const [name, setName] = useState(workspace.name);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");

  const team = useQuery({ queryKey: ["team"], queryFn: () => call<{ members: Member[]; invitations: Invitation[] }>("/api/workspace/members") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["team"] });
  const onError = (e: Error) => toast.error(e.message);

  const rename = useMutation({
    mutationFn: () => call("/api/workspace", { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      toast.success("Workspace renamed");
      router.refresh();
    },
    onError,
  });
  const invite = useMutation({
    mutationFn: () => call<Invitation>("/api/workspace/invitations", { method: "POST", body: JSON.stringify({ email, role }) }),
    onSuccess: (i) => {
      toast.success(`Invitation sent to ${i.email}`);
      setEmail("");
      void refresh();
    },
    onError,
  });
  const setMemberRole = useMutation({
    mutationFn: (v: { userId: string; role: string }) => call(`/api/workspace/members/${v.userId}`, { method: "PATCH", body: JSON.stringify({ role: v.role }) }),
    onSuccess: () => void refresh(),
    onError: (e: Error) => {
      onError(e);
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => call(`/api/workspace/members/${userId}`, { method: "DELETE" }),
    onSuccess: (_d, userId) => {
      if (userId === me) {
        toast.success(`You left ${workspace.name}`);
        qc.clear();
        router.push("/app/workflows");
        router.refresh();
      } else void refresh();
    },
    onError,
  });
  const cancelInvite = useMutation({
    mutationFn: (id: string) => call(`/api/workspace/invitations/${id}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
    onError,
  });

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Team & settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {workspace.personal ? "Your personal workspace. Create a team from the workspace menu to work with others." : `Settings for ${workspace.name}.`}
        </p>
      </div>

      <section aria-labelledby="ws-h" className="grid gap-3">
        <h2 id="ws-h" className="font-medium">
          Workspace
        </h2>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            rename.mutate();
          }}
        >
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="ws-name">Name</Label>
            <Input id="ws-name" value={name} maxLength={80} disabled={!manage} onChange={(e) => setName(e.target.value)} />
          </div>
          {manage && (
            <Button type="submit" variant="outline" disabled={rename.isPending || !name.trim() || name === workspace.name}>
              {rename.isPending && <Loader2Icon className="animate-spin" />}
              Save
            </Button>
          )}
        </form>
      </section>

      {!workspace.personal && (
        <section aria-labelledby="members-h" className="grid gap-3">
          <h2 id="members-h" className="font-medium">
            Members
          </h2>
          {manage && (
            <form
              aria-label="Invite a member"
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                invite.mutate();
              }}
            >
              <div className="grid flex-1 gap-1.5">
                <Label htmlFor="invite-email">Invite by email</Label>
                <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
              </div>
              <div className="grid gap-1.5 sm:w-36">
                <Label htmlFor="invite-role">Role</Label>
                <NativeSelect id="invite-role" className="h-9" value={role} onChange={(e) => setRole(e.target.value)}>
                  {(workspace.role === "owner" ? ["admin", "editor", "viewer"] : ["editor", "viewer"]).map((r) => (
                    <option key={r} value={r}>
                      {r[0]!.toUpperCase() + r.slice(1)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <Button type="submit" disabled={invite.isPending || !email.trim()}>
                {invite.isPending ? <Loader2Icon className="animate-spin" /> : <MailIcon data-icon="inline-start" />}
                Send invite
              </Button>
            </form>
          )}
          {team.isPending ? (
            <Skeleton className="h-24" />
          ) : team.isError ? (
            <p className="text-sm text-destructive">{team.error.message}</p>
          ) : (
            <>
              <ul className="grid divide-y rounded-xl border" aria-label="Members">
                {team.data.members.map((m) => (
                  <li key={m.userId} className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap">
                    <UsersIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {m.name || m.email}
                        {m.userId === me && <span className="text-muted-foreground"> (you)</span>}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                    </div>
                    {manage && m.userId !== me ? (
                      <NativeSelect
                        aria-label={`Role for ${m.email}`}
                        className="h-8 w-28"
                        value={m.role}
                        title={ROLE_HELP[m.role]}
                        onChange={(e) => setMemberRole.mutate({ userId: m.userId, role: e.target.value })}
                      >
                        {["owner", "admin", "editor", "viewer"].map((r) => (
                          <option key={r} value={r} disabled={r === "owner" && workspace.role !== "owner"}>
                            {r[0]!.toUpperCase() + r.slice(1)}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <span className="text-xs text-muted-foreground capitalize" title={ROLE_HELP[m.role]}>
                        {m.role}
                      </span>
                    )}
                    {(m.userId === me || manage) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={m.userId === me ? "Leave workspace" : `Remove ${m.email}`}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(m.userId)}
                      >
                        {m.userId === me ? "Leave" : <Trash2Icon />}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {team.data.invitations.length > 0 && (
                <ul className="grid divide-y rounded-xl border border-dashed" aria-label="Pending invitations">
                  {team.data.invitations.map((i) => (
                    <li key={i.id} className="flex items-center gap-3 p-3">
                      <MailIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <p className="min-w-0 flex-1 truncate text-sm">
                        {i.email} <span className="text-muted-foreground">· invited as {i.role}</span>
                      </p>
                      <Button variant="ghost" size="sm" aria-label={`Cancel invitation for ${i.email}`} onClick={() => cancelInvite.mutate(i.id)}>
                        Cancel
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      <VariablesSettings canEdit={workspace.role !== "viewer"} />

      <SecuritySettings />

      {manage && <DeveloperSettings />}
    </div>
  );
}
