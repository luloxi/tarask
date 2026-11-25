"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, Sheet, X } from "lucide-react";
import {
  createSheet,
  findSheet,
  friendlyMessage,
  loadGoogleIdentity,
  requestToken,
  SheetsError,
  updateSheet,
  versionTitle,
  type SheetFile,
  type SheetsExportData,
} from "@/lib/sheets/google-sheets";

type Oauth2 = Awaited<ReturnType<typeof loadGoogleIdentity>>;
type Stage =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "working"; label: string }
  | { kind: "choose"; file: SheetFile }
  | { kind: "done"; file: SheetFile; created: boolean }
  | { kind: "error"; message: string };

const APP = "Tarask";

/** "Guardar en Google Sheets": one small dialog, opened from the Más menu. */
export function SheetsExportDialog({ onClose }: { onClose: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const data = useRef<SheetsExportData | null>(null);
  const oauth2 = useRef<Oauth2 | null>(null);
  const [hasClient, setHasClient] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = fetch("/api/export/sheets", { credentials: "include", cache: "no-store" }).then(async (res) => {
      if (!res.ok) throw new SheetsError(res.status === 401 ? "auth" : "unknown");
      return (await res.json()) as SheetsExportData;
    });
    Promise.all([load, loadGoogleIdentity()])
      .then(([payload, gis]) => {
        if (cancelled) return;
        data.current = payload;
        oauth2.current = gis;
        setHasClient(Boolean(payload.clientId));
        if (!payload.clientId) setStage({ kind: "error", message: friendlyMessage(new SheetsError("not_configured"), APP) });
        else setStage({ kind: "ready" });
      })
      .catch((err: unknown) => {
        if (!cancelled) setStage({ kind: "error", message: friendlyMessage(err, APP) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Called straight from a click: the Google popup must open inside the tap. */
  function token(): Promise<string> {
    const d = data.current;
    const g = oauth2.current;
    if (!d?.clientId || !g) return Promise.reject(new SheetsError("not_configured"));
    return requestToken(g, d.clientId, d.loginHint);
  }

  function fail(err: unknown) {
    setStage({ kind: "error", message: friendlyMessage(err, APP) });
  }

  function start() {
    const d = data.current;
    if (!d) return;
    const pending = token();
    setStage({ kind: "working", label: "Conectando con Google…" });
    pending
      .then(async (t) => {
        const existing = await findSheet(t, APP, d.exportKey);
        if (existing) {
          setStage({ kind: "choose", file: existing });
          return;
        }
        setStage({ kind: "working", label: "Creando tu planilla…" });
        const file = await createSheet(t, d, d.fileTitle);
        setStage({ kind: "done", file, created: true });
      })
      .catch(fail);
  }

  function update(file: SheetFile) {
    const d = data.current;
    if (!d) return;
    const pending = token();
    setStage({ kind: "working", label: "Actualizando la planilla…" });
    pending
      .then(async (t) => {
        try {
          const saved = await updateSheet(t, file, d);
          setStage({ kind: "done", file: saved, created: false });
        } catch (err) {
          // Deleted while the dialog was open: make a fresh one instead.
          if (err instanceof SheetsError && err.kind === "not_found") {
            const created = await createSheet(t, d, d.fileTitle);
            setStage({ kind: "done", file: created, created: true });
            return;
          }
          throw err;
        }
      })
      .catch(fail);
  }

  function newVersion() {
    const d = data.current;
    if (!d) return;
    const pending = token();
    setStage({ kind: "working", label: "Creando la versión nueva…" });
    pending
      .then(async (t) => {
        const file = await createSheet(t, d, versionTitle(d.fileTitle, new Date()));
        setStage({ kind: "done", file, created: true });
      })
      .catch(fail);
  }

  const busy = stage.kind === "working" || stage.kind === "loading";

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="sheets-export-title">
      <button
        type="button"
        aria-label="Cerrar"
        className="absolute inset-0 cursor-pointer bg-[#0b0b12]/45 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        className="relative z-10 w-full max-w-sm rounded-t-[1.75rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--card-shadow-lg)] sm:rounded-[1.5rem]"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--accent)_22%,var(--surface))] text-[var(--text)]">
              <Sheet className="h-5 w-5" strokeWidth={1.8} />
            </span>
            <h2 id="sheets-export-title" className="text-lg font-semibold tracking-tight">
              Guardar en Google Sheets
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="-mr-2 -mt-1 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-[var(--muted)] hover:bg-[var(--surface-muted)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 space-y-4 text-[15px] leading-relaxed">
          {(stage.kind === "loading" || stage.kind === "ready") && (
            <>
              <p className="text-[var(--muted)]">
                Una copia de tus datos en una planilla de tu Google Drive. Es solo para mirar: lo que cambies ahí no vuelve a Tarask.
              </p>
              <button type="button" className="lc-btn lc-btn-primary w-full" disabled={busy} onClick={start}>
                {stage.kind === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Guardar en Google Sheets
              </button>
            </>
          )}

          {stage.kind === "working" && (
            <p className="flex items-center gap-2 text-[var(--muted)]" role="status">
              <Loader2 className="h-4 w-4 animate-spin" />
              {stage.label}
            </p>
          )}

          {stage.kind === "choose" && (
            <>
              <p className="text-[var(--muted)]">
                Ya tenés <span className="font-semibold text-[var(--text)]">{stage.file.name}</span>. ¿Qué hacemos?
              </p>
              <div className="grid gap-2">
                <button type="button" className="lc-btn lc-btn-primary w-full" onClick={() => update(stage.file)}>
                  Actualizar este archivo
                </button>
                <button type="button" className="lc-btn lc-btn-secondary w-full" onClick={newVersion}>
                  Crear una versión nueva
                </button>
              </div>
            </>
          )}

          {stage.kind === "done" && (
            <>
              <p className="text-[var(--muted)]">{stage.created ? "Listo, tu planilla está creada." : "Listo, tu planilla está al día."}</p>
              <a
                href={stage.file.url}
                target="_blank"
                rel="noopener noreferrer"
                className="lc-btn lc-btn-primary w-full"
              >
                Abrir en Google Sheets
                <ExternalLink className="h-4 w-4" />
              </a>
            </>
          )}

          {stage.kind === "error" && (
            <>
              <p className="text-[var(--muted)]" role="alert">
                {stage.message}
              </p>
              <div className="grid gap-2">
                {hasClient ? (
                  <button type="button" className="lc-btn lc-btn-primary w-full" onClick={() => setStage({ kind: "ready" })}>
                    Probar de nuevo
                  </button>
                ) : null}
                <button type="button" className="lc-btn lc-btn-secondary w-full" onClick={onClose}>
                  Cerrar
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
