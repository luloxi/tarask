import { isPeriodDebtSource } from "@/lib/import/source";

export function buildImportMessage(r: {
  total: number;
  uniqueInFile: number;
  duplicatesInFile: number;
  alreadyExists: number;
  inserted: number;
}): { message: string; warning: string | null; fullyDuplicate: boolean; overlapPct: number } {
  const overlapPct =
    r.uniqueInFile > 0
      ? Math.round((r.alreadyExists / r.uniqueInFile) * 100)
      : 0;
  const fullyDuplicate = r.uniqueInFile > 0 && r.inserted === 0;

  if (r.total === 0) {
    return {
      message: "No se leyeron movimientos del archivo.",
      warning: null,
      fullyDuplicate: false,
      overlapPct: 0,
    };
  }

  if (fullyDuplicate) {
    const warning =
      r.alreadyExists > 0
        ? `Este resumen parece ya estar cargado: ${r.alreadyExists} coincidencia${r.alreadyExists === 1 ? "" : "s"} con lo que ya tenés. No se importó nada nuevo.`
        : `El archivo no tenía movimientos nuevos para importar.`;
    return {
      message: warning,
      warning,
      fullyDuplicate: true,
      overlapPct,
    };
  }

  const parts: string[] = [];
  parts.push(
    `${r.inserted} movimiento${r.inserted === 1 ? "" : "s"} nuevo${r.inserted === 1 ? "" : "s"}`,
  );
  if (r.alreadyExists > 0) {
    parts.push(
      `${r.alreadyExists} ya existían (coincidencias con lo cargado)`,
    );
  }
  if (r.duplicatesInFile > 0) {
    parts.push(
      `${r.duplicatesInFile} fila${r.duplicatesInFile === 1 ? "" : "s"} repetida${r.duplicatesInFile === 1 ? "" : "s"} en el archivo`,
    );
  }
  parts.push(`${r.total} filas leídas`);

  let warning: string | null = null;
  if (overlapPct >= 80) {
    warning = `Alta superposición (${overlapPct}%): este archivo se parece mucho a un resumen ya importado. Solo se agregaron ${r.inserted} nuevos.`;
  } else if (r.alreadyExists > 0) {
    warning = `${r.alreadyExists} coincidencia${r.alreadyExists === 1 ? "" : "s"} con movimientos ya cargados (misma fecha, comercio e importe). Esos no se volvieron a importar.`;
  }

  return {
    message: parts.join(" · "),
    warning,
    fullyDuplicate: false,
    overlapPct,
  };
}

export function otherCardNote(
  skippedOtherCard: number,
  primaryCardLast4: string | null,
  source: string,
): string {
  if (skippedOtherCard <= 0 || !primaryCardLast4) return "";
  const period = isPeriodDebtSource(source)
    ? " El período entra en Deuda, no en la neta."
    : "";
  return ` Se omitió la otra tarjeta (${skippedOtherCard} filas; tu cuenta es ****${primaryCardLast4}).${period}`;
}
