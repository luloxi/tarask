import { Suspense } from "react";
import { AppNav } from "@/components/app-nav";
import { AddExpenseProvider } from "@/components/add-expense-provider";
import { AuthGate } from "@/components/auth-gate";
import { SectionSwipe } from "@/components/section-swipe";
import { RegisterServiceWorker } from "@/components/register-sw";
import { DashboardSkeleton } from "@/components/ui";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="app-shell flex min-h-dvh flex-col">
      <RegisterServiceWorker />
      <AuthGate>
        <AddExpenseProvider>
          <AppNav />
          <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pb-[calc(6.5rem+env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))] md:px-6 md:pb-12 md:pt-8">
            <Suspense fallback={<DashboardSkeleton />}>
              <SectionSwipe>{children}</SectionSwipe>
            </Suspense>
          </main>
        </AddExpenseProvider>
      </AuthGate>
    </div>
  );
}
