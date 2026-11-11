import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAIN_TABS,
  SECTION_TABS,
  activeMainTab,
  activeSectionTab,
  homeNextAction,
  isMoreActive,
  isUnlistedNavHref,
  moreLinksFor,
} from "./nav";
import { DEUDA_ENABLED, isDeudaEnabled } from "./features";
import {
  swipeIncludesDeuda,
  swipePathFor,
  resolveSwipeIndex,
  stepToHref,
} from "./swipe-path";

describe("nav del rediseño", () => {
  it("la barra tiene 4 pestañas en lenguaje simple", () => {
    assert.deepEqual(
      MAIN_TABS.map((t) => t.label),
      ["Resumen", "Movimientos", "Patrimonio", "Hogar"],
    );
    assert.deepEqual(
      MAIN_TABS.map((t) => t.href),
      ["/dashboard", "/consumos", "/patrimonio", "/compartido"],
    );
  });

  it("Más lleva Categorías y MCP, y Administración solo para admins", () => {
    const guest = moreLinksFor(false);
    assert.deepEqual(guest.map((l) => l.href), ["/categorias", "/mcp"]);
    const admin = moreLinksFor(true);
    assert.equal(admin.at(-1)?.href, "/admin");
    assert.equal(admin.at(-1)?.label, "Administración");
    assert.equal(guest.some((l) => l.href === "/admin"), false);
  });

  it("cada ruta vieja cae en una pestaña (no se perdió ninguna pantalla)", () => {
    const expected: Record<string, string> = {
      "/dashboard": "/dashboard",
      "/consumos": "/consumos",
      "/ingresos": "/consumos",
      "/mes-a-mes": "/consumos",
      "/analisis": "/consumos",
      "/patrimonio": "/patrimonio",
      "/ahorros": "/patrimonio",
      "/saldos": "/patrimonio",
      "/deuda": "/patrimonio",
      "/deuda/detalle": "/patrimonio",
      "/cargas": "/patrimonio",
      "/compartido": "/compartido",
      "/grupo": "/compartido",
      "/pareja": "/compartido",
      "/supermercado": "/compartido",
    };
    for (const [path, tab] of Object.entries(expected)) {
      assert.equal(activeMainTab(path), tab, path);
      assert.equal(activeMainTab(`${path}/`), tab, `${path}/`);
    }
    assert.equal(activeMainTab("/categorias"), null);
    assert.equal(isMoreActive("/categorias"), true);
    assert.equal(isMoreActive("/mcp"), true);
    assert.equal(isMoreActive("/dashboard"), false);
  });

  it("los chips de Movimientos distinguen Gastos, Por mes, Gráficos y Fiwind", () => {
    assert.equal(activeSectionTab("movimientos", "/consumos", null), "gastos");
    assert.equal(activeSectionTab("movimientos", "/consumos", "lista"), "gastos");
    assert.equal(activeSectionTab("movimientos", "/consumos", "resumen"), "por-mes");
    assert.equal(activeSectionTab("movimientos", "/consumos", "charts"), "graficos");
    assert.equal(activeSectionTab("movimientos", "/consumos", "fiwind"), "fiwind");
    assert.equal(activeSectionTab("movimientos", "/ingresos", null), "ingresos");
  });

  it("los chips de Patrimonio y Hogar apuntan a las rutas de siempre", () => {
    assert.deepEqual(
      SECTION_TABS.patrimonio.map((t) => t.href),
      ["/patrimonio", "/ahorros", "/saldos", "/deuda", "/cargas"],
    );
    assert.deepEqual(
      SECTION_TABS.hogar.map((t) => t.href),
      ["/compartido", "/grupo", "/supermercado"],
    );
    assert.equal(activeSectionTab("patrimonio", "/deuda", null), "deuda");
    assert.equal(activeSectionTab("patrimonio", "/cargas", null), "resumenes");
    assert.equal(activeSectionTab("hogar", "/supermercado", null), "super");
  });

  it("Suscripción, Importar y Compartir siguen fuera de la navegación", () => {
    for (const href of ["/share-target", "/suscripcion", "/importar"]) {
      assert.equal(isUnlistedNavHref(href), true);
      assert.equal(MAIN_TABS.some((t) => t.href === href), false);
    }
    assert.equal(isUnlistedNavHref("/cargas"), false);
  });
});

describe("DEUDA_ENABLED (no flag)", () => {
  it("is always on: no env value hides it", () => {
    for (const v of ["1", "true", "0", "false", "", undefined]) {
      assert.equal(isDeudaEnabled(v), true);
    }
    assert.equal(DEUDA_ENABLED, true);
  });

  it("keeps swipe on the slim path when the flag is off", () => {
    const off = swipePathFor(false);
    assert.equal(swipeIncludesDeuda(off), false);
    assert.ok(off.every((s) => s.href !== "/deuda"));
    assert.deepEqual(
      off.map((s) => ("tab" in s ? `${s.href}?tab=${s.tab}` : s.href)),
      [
        "/dashboard",
        "/consumos?tab=lista",
        "/consumos?tab=resumen",
        "/consumos?tab=charts",
        "/compartido?tab=vista",
        "/compartido?tab=charts",
        "/ahorros",
      ],
    );
  });

  it("only adds /deuda steps when the flag is on", () => {
    const on = swipePathFor(true);
    assert.equal(swipeIncludesDeuda(on), true);
    assert.ok(on.some((s) => s.href === "/deuda" && "tab" in s && s.tab === "evolucion"));
    assert.ok(on.some((s) => s.href === "/deuda" && "tab" in s && s.tab === "pagos"));
    assert.equal(on.length, swipePathFor(false).length + 2);
  });
});

describe("home next action", () => {
  it("stays on Consumos and never opens Cargas", () => {
    for (const n of [0, -1, 1, 12]) {
      assert.deepEqual(homeNextAction(n), {
        href: "/consumos",
        label: "Ver movimientos",
      });
    }
  });

  it("does not send the next action to Deuda or Cargas", () => {
    assert.notEqual(homeNextAction(0).href, "/deuda");
    assert.notEqual(homeNextAction(0).href, "/cargas");
    assert.notEqual(homeNextAction(3).href, "/deuda");
    assert.notEqual(homeNextAction(3).href, "/cargas");
  });
});

describe("swipe index (flag off path)", () => {
  it("resolves Inicio and Consumos tabs", () => {
    assert.equal(resolveSwipeIndex("/dashboard", null), 0);
    assert.equal(resolveSwipeIndex("/consumos", "lista"), 1);
    assert.equal(resolveSwipeIndex("/consumos", "resumen"), 2);
    assert.equal(resolveSwipeIndex("/consumos", "charts"), 3);
  });

  it("does not land on Deuda from a deep link when the swipe path is off", () => {
    const hrefs = swipePathFor(false).map(stepToHref);
    assert.ok(!hrefs.some((h) => h.includes("/deuda")));
  });

  it("builds hrefs without Deuda on the slim path", () => {
    const hrefs = swipePathFor(false).map(stepToHref);
    assert.ok(!hrefs.some((h) => h.includes("/deuda")));
  });
});
