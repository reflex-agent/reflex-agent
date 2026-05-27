import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";

// Locale is read from settings.json per request, so nothing can be safely
// prerendered. Forcing this at the root layer covers every child page.
export const dynamic = "force-dynamic";
import { Toaster } from "@/components/ui/sonner";
import { AppSidebar } from "./_components/app-sidebar";
import { listRoots } from "@/lib/registry";
import { startScheduler } from "@/lib/server/workflows/scheduler";

// Boot the background workflow scheduler the first time any page is
// rendered. `startScheduler` is idempotent — guarded by a global, so
// it's safe to call on every request.
startScheduler();

export const metadata: Metadata = {
  title: "Reflex",
  description: "Local-first knowledge base built by an agent.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const roots = await listRoots();
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale} suppressHydrationWarning>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <div className="h-screen flex">
            <AppSidebar initialRoots={roots} />
            <main className="flex-1 min-w-0 flex flex-col">{children}</main>
          </div>
          <Toaster richColors closeButton />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
