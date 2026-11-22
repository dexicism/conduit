import type { Metadata } from "next";
import { loadPublishedChat } from "@/lib/chat";
import { PublicChat } from "./public-chat";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/chat/[path]">): Promise<Metadata> {
  const chat = await loadPublishedChat((await props.params).path);
  return { title: chat?.title ?? "Chat not found", robots: { index: false } };
}

export default async function ChatPage(props: PageProps<"/chat/[path]">) {
  const { path } = await props.params;
  const chat = await loadPublishedChat(path);
  return (
    <main className="mx-auto flex h-dvh w-full max-w-2xl flex-col px-4 py-4 sm:py-8">
      {!chat ? (
        <div className="grid gap-2 py-6">
          <h1 className="text-xl font-semibold">This chat isn&apos;t available</h1>
          <p className="text-sm text-muted-foreground">The link may be wrong, or the chat was turned off.</p>
        </div>
      ) : (
        <PublicChat path={path} title={chat.title} welcomeMessage={chat.welcomeMessage} placeholder={chat.placeholder} />
      )}
      <p className="pt-2 text-center text-xs text-muted-foreground">Powered by Conduit</p>
    </main>
  );
}
