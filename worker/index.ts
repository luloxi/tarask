import {
  handleGoogleCallback,
  handleGoogleStart,
  handleLogout,
  isUser,
  requireUser,
} from "./auth";
import { handleAgentToken } from "./agent-token";
import { handleAllowedEmails } from "./allowed-emails";
import { handleBillingSubscription } from "./billing";
import { handleCargas } from "./cargas";
import { handleCategories } from "./categories";
import { handleCompartidoStats } from "./compartido";
import { handleBalancesGet, handleBalancesManual, handleBalancesRoutine } from "./balances";
import { handleDashboard } from "./dashboard";
import { handleIncomeByMonth, handleSpendingByCategory, handleSpendingSeries } from "./insights";
import { handleGrupo } from "./grupo";
import { handleMesAMes } from "./mes-a-mes";
import { handleReceiptFile, handleReceipts } from "./receipts";
import { handleImportStatement, handlePdfText } from "./import";
import type { Env, WorkerContext } from "./env";
import {
  captureDailySnapshots,
  handleAhorros,
  handleDebtSettings,
  handleDebtStats,
  handlePatrimonio,
  handlePatrimonioSnapshot,
} from "./finance";
import { json, notPorted } from "./http";
import { handleHouseholdActive, handleMe } from "./household-routes";
import { handleIncomes } from "./incomes-api";
import { flushOutbox } from "./serpix-sync";
import { handleSvc } from "./svc";
import { handleTransactions } from "./transactions";
import { handleFiwindReclassify } from "./reclassify";
import { redirectLegacyHost } from "./legacy-host";

const worker = {
  async fetch(req: Request, env: Env, ctx?: WorkerContext): Promise<Response> {
    const legacy = redirectLegacyHost(req);
    if (legacy) return legacy;
    const url = new URL(req.url);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    try {
      if (path === "/api/auth/google" && req.method === "GET") {
        return await handleGoogleStart(req, env);
      }
      if (path === "/api/auth/callback/google" && req.method === "GET") {
        return await handleGoogleCallback(req, env);
      }
      if (path === "/api/auth/logout" && req.method === "POST") {
        return await handleLogout(req, env);
      }
      if (path === "/api/svc" || path.startsWith("/api/svc/")) {
        return await handleSvc(req, env);
      }
      if (path === "/api/balances" && req.method === "POST") {
        return await handleBalancesRoutine(req, env);
      }
      if (!path.startsWith("/api/")) {
        if (path.startsWith("/.well-known/")) return json({ error: "No encontrado" }, 404);
        return env.ASSETS.fetch(req);
      }

      const user = await requireUser(req, env);
      if (!isUser(user)) return user;

      if (path === "/api/me" && req.method === "GET") return await handleMe(req, env, user);
      if (path === "/api/dashboard" && req.method === "GET") {
        return await handleDashboard(req, env, user);
      }
      if (path === "/api/transactions") return await handleTransactions(req, env, user, ctx);
      if (path === "/api/categories" && req.method === "GET") {
        return await handleCategories(req, env, user);
      }
      if (path === "/api/household/active") return await handleHouseholdActive(req, env, user);
      if (path === "/api/ahorros") return await handleAhorros(req, env, user);
      if (path === "/api/debt-settings") return await handleDebtSettings(req, env, user);
      if (path === "/api/stats/deuda" && req.method === "GET") {
        return await handleDebtStats(req, env, user);
      }
      if (path === "/api/patrimonio/snapshot") return await handlePatrimonioSnapshot(req, env, user);
      if (path === "/api/patrimonio" && req.method === "GET") {
        return await handlePatrimonio(req, env, user);
      }
      if (path === "/api/incomes") return await handleIncomes(req, env, user);
      if (path === "/api/income-by-month") return await handleIncomeByMonth(req, env, user);
      if (path === "/api/spending-by-category") return await handleSpendingByCategory(req, env, user);
      if (path === "/api/spending-series") return await handleSpendingSeries(req, env, user);
      if (path === "/api/balances/manual") return await handleBalancesManual(req, env, user);
      if (path === "/api/balances") return await handleBalancesGet(req, env, user);
      if (path === "/api/cargas" && req.method === "GET") {
        return await handleCargas(req, env, user);
      }
      if (path === "/api/stats/compartido" && req.method === "GET") {
        return await handleCompartidoStats(req, env, user);
      }
      if (path === "/api/billing/subscription" && req.method === "GET") {
        return await handleBillingSubscription(req, env, user);
      }
      if (path === "/api/stats/mes-a-mes") return await handleMesAMes(req, env, user);
      if (path === "/api/grupo") return await handleGrupo(req, env, user);
      if (path === "/api/receipts") return await handleReceipts(req, env, user);
      if (path.startsWith("/api/receipts/file/")) return await handleReceiptFile(req, env, user);
      if (path === "/api/import/statement") return await handleImportStatement(req, env, user);
      if (path === "/api/import/pdf-text") return await handlePdfText(req, env);
      if (path === "/api/admin/allowed-emails") return await handleAllowedEmails(req, env, user);
      if (path === "/api/household/agent-token") return await handleAgentToken(req, env, user);
      if (path.startsWith("/api/fiwind/")) return await handleFiwindReclassify(req, env, user);
      return notPorted();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error interno";
      return json({ error: message.slice(0, 300) }, 500);
    }
  },

  async scheduled(_event: unknown, env: Env, ctx: WorkerContext): Promise<void> {
    const outbox = flushOutbox(env).catch((err) => {
      console.error("outbox flush failed", err instanceof Error ? err.message : "error");
    });
    const snapshots = captureDailySnapshots(env).catch((err) => {
      console.error("patrimonio snapshot failed", err instanceof Error ? err.message : "error");
    });
    const work = Promise.all([outbox, snapshots]).then(() => undefined);
    ctx.waitUntil(work);
    await work;
  },
};

export default worker;
