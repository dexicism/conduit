import type { Metadata } from "next";
import { loadPublishedForm } from "@/lib/forms";
import { PublicForm } from "./public-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/form/[path]">): Promise<Metadata> {
  const form = await loadPublishedForm((await props.params).path);
  return { title: form?.title ?? "Form not found", robots: { index: false } };
}

export default async function FormPage(props: PageProps<"/form/[path]">) {
  const { path } = await props.params;
  const form = await loadPublishedForm(path);
  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-lg content-start gap-6 px-4 py-10 sm:py-16">
      {!form ? (
        <div className="grid gap-2">
          <h1 className="text-xl font-semibold">This form isn&apos;t available</h1>
          <p className="text-sm text-muted-foreground">The link may be wrong, or the form was turned off.</p>
        </div>
      ) : (
        <PublicForm
          path={path}
          title={form.title}
          description={form.description}
          questions={form.questions.map((q) => ({ name: q.name, label: q.label, type: q.type, required: q.required, options: q.options ?? "" }))}
          submitLabel={form.submitLabel}
        />
      )}
      <p className="text-center text-xs text-muted-foreground">Powered by Conduit</p>
    </main>
  );
}
