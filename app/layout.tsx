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

// Background workers (scheduler + Telegram poller) are booted from the
// root `instrumentation.ts` register() hook, NOT here. `next dev` renders
// this layout in MULTIPLE worker processes (each with its own globalThis),
// so a top-level boot here started one Telegram poller per worker → several
// pollers on the same bot → Telegram 409 ("terminated by other getUpdates")
// + duplicate processing. The instrumentation hook runs once, in the single
// API-serving server process, in both dev and prod.

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
          <div className="h-screen flex overflow-hidden">
            <AppSidebar initialRoots={roots} />
            <main className="flex-1 min-w-0 flex flex-col overflow-y-auto">
              {children}
            </main>
          </div>
          <Toaster richColors closeButton />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
