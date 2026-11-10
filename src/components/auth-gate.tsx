"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api/client";
import { DashboardSkeleton } from "@/components/ui";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiGet("/api/me", 5000).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        const next = res.status === 403 ? "/login?error=forbidden" : "/login";
        window.location.replace(next);
        return;
      }
      setReady(true);
    }).catch(() => {
      if (!cancelled) window.location.replace("/login");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div className="mx-auto w-full max-w-5xl flex-1 px-4 pt-[max(1.25rem,env(safe-area-inset-top))] md:px-6 md:pt-8">
        <DashboardSkeleton />
      </div>
    );
  }
  return children;
}
