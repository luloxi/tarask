# Agent API + MCP remoto (token por hogar)

Tarask expone los mismos datos del hogar por:

1. **HTTP Agent API** (`/api/agent/*`) — ideal para `curl` / scripts.
2. **MCP remoto** (`/api/mcp`) — Streamable HTTP para grok.com, Cursor u otros clientes MCP.

Ambos usan el **token del hogar** (Bearer) y la misma lógica (no inventan números). La PWA sigue con cookie de sesión; esto es para máquinas / IAs.

UI de setup (español): **`/mcp`** en la PWA (`https://tarask.lulox.com.ar/mcp`).

Polar (suscripción por hogar) y monotributo **no** se implementan acá: primero token por hogar, después Polar, después monotributo.

## Auth

```
Authorization: Bearer <token del hogar>
```

El token se genera en la PWA (`/mcp`), se guarda **hasheado** y se muestra **una sola vez**. Resuelve siempre a **ese** `household_id`: el hogar A no ve al B.

Cookie login sigue para la PWA. Bearer es para agentes / MCP.

### Cómo mintar un token del hogar

1. Entrá a la PWA con tu usuario (sesión).
2. Andá a **https://tarask.lulox.com.ar/mcp** (también hay un atajo “Token MCP” en Hogar).
3. Tocá **Generar token del hogar**. Copiá el valor ahora: no se vuelve a mostrar.
4. Pegalo en grok.com / Grok CLI / Cursor como `Authorization: Bearer …` (en la config del MCP, **no** en el chat).
5. Si se filtró o lo perdiste: **Rotar** (invalida el anterior) o **Revocar**.

`POST /api/household/agent-token` (sesión, no Bearer) con `{ "action": "create" | "rotate" }` devuelve `{ token, prefix, household }`. `DELETE` revoca.

### Fallback admin/dev (no es el producto)

El secreto de entorno `AGENT_API_TOKEN` sigue andando como **fallback interno**. Mapea al usuario de `AGENT_USER_ID` / `AGENT_USER_EMAIL` y a **su** hogar, no a todos los hogares. No sirve para vender el .com multi-tenant.

| Name | Required | Purpose |
| --- | --- | --- |
| `AGENT_API_TOKEN` | no (fallback) | Bearer admin/dev. Mismo valor en Vercel y en el entorno del agente interno. |
| `AGENT_USER_ID` | optional | `users.id` del hogar de admin/dev (`household_members`). Solo con el fallback global. |
| `AGENT_USER_EMAIL` | optional | Si `AGENT_USER_ID` falta o no tiene hogar. |

No hay env nuevos para el token por hogar: vive en D1 (hash).

The PWA user must already belong to a household to mint a token.
If tools return `code: "no_household"`, mint from `/mcp` while logged into that hogar.

## MCP remoto

- **URL:** `https://tarask.lulox.com.ar/api/mcp`
- **Transport:** Streamable HTTP (MCP 2025/2026). Stateless on Cloudflare Workers (OpenNext). El host anterior `https://llevacuentas.vercel.app` queda solo como legado.
- **Auth:** header `Authorization: Bearer <token del hogar>` (no OAuth browser flow).

### Tools

El endpoint vive en el Worker (`/api/mcp`, también se acepta POST `/mcp`). La página `/mcp` es solo la UI para generar el token.

| Tool | Qué hace |
| --- | --- |
| `resumen_mensual` | Resumen mensual de ingresos y gastos (`from`/`to` en `YYYY-MM`). |
| `deuda_ahorro_patrimonio` | Deuda, ahorros y patrimonio. |
| `ultimos_movimientos` | Últimos movimientos (`limit`, `period`, `query`). |
| `gastos_del_mes` | Totales reales; `period` opcional (`YYYY-MM`, `latest`, o mes actual AR). |
| `listar_cargas` | Historial de cargas (resúmenes, tickets, manuales). |

Importar un resumen se hace en la PWA (`/cargas`): el Worker ya no parsea el archivo (eso corre en el dispositivo).

Todas las tools filtran por el `household_id` del token.

### grok.com / Grok CLI

```bash
export LLEVACUENTAS_TOKEN="…"   # token del hogar, copiado una vez desde /mcp

grok mcp add --transport http llevacuentas \
  https://tarask.lulox.com.ar/api/mcp \
  --header "Authorization: Bearer ${LLEVACUENTAS_TOKEN}"
```

O en `~/.grok/config.toml`:

```toml
[mcp_servers.llevacuentas]
url = "https://tarask.lulox.com.ar/api/mcp"
headers = { Authorization = "Bearer ${LLEVACUENTAS_TOKEN}" }
```

En grok.com: MCP remoto Streamable HTTP, misma URL, header `Authorization: Bearer …`. No pegues el token en el chat.

### Cursor / cliente genérico

```json
{
  "mcpServers": {
    "llevacuentas": {
      "url": "https://tarask.lulox.com.ar/api/mcp",
      "headers": {
        "Authorization": "Bearer ${LLEVACUENTAS_TOKEN}"
      }
    }
  }
}
```

Metadata RFC 9728 (descubrimiento): `/.well-known/oauth-protected-resource`.
El flujo esperado es bearer estático, no un Authorization Server interactivo.

## HTTP calls (curl)

Replace `$APP_URL` with the Vercel origin (same host as the PWA).
`$LLEVACUENTAS_TOKEN` is the household token from `/mcp`.

### 1. Load summary (stored statements + current month)

```bash
curl -sS -H "Authorization: Bearer $LLEVACUENTAS_TOKEN" \
  "$APP_URL/api/agent/summary"
```

### 1b. Import a statement (BBVA / Fiwind Excel, CSV o PDF)

Same parser as the PWA import (`/cargas`). Detects BBVA PDF, generic
fecha+importe PDF (Fiwind y otros), Excel y CSV (coma o `;`). Si el nombre
o el contenido dice Fiwind, no se etiqueta como BBVA. Pass `bank=Fiwind` to
force the label.

Multipart:

```bash
curl -sS -H "Authorization: Bearer $LLEVACUENTAS_TOKEN" \
  -F "file=@resumen.xlsx" -F "bank=BBVA" \
  "$APP_URL/api/agent/import"
```

JSON (when the agent already has bytes as base64):

```bash
curl -sS -H "Authorization: Bearer $LLEVACUENTAS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fileName":"resumen.xlsx","bank":"BBVA","fileBase64":"<base64>"}' \
  "$APP_URL/api/agent/import"
```

### 2. Gastos del mes (real stored totals)

Current calendar month (America/Argentina/Buenos_Aires):

```bash
curl -sS -H "Authorization: Bearer $LLEVACUENTAS_TOKEN" \
  "$APP_URL/api/agent/gastos"
```

A specific month, or the latest month that has data:

```bash
curl -sS -H "Authorization: Bearer $LLEVACUENTAS_TOKEN" \
  "$APP_URL/api/agent/gastos?period=2026-08"

curl -sS -H "Authorization: Bearer $LLEVACUENTAS_TOKEN" \
  "$APP_URL/api/agent/gastos?period=latest"
```

Read `formatted.headline` plus `totalArs` / `totalUsd` / `totalArsCombined`.
Empty months return zeros — never invented figures.

`GET /api/agent` (auth required) lists HTTP + MCP and echoes `actingAs.householdId` + `authKind` (`household_token` | `global_token` | `session`).

Bearer also works on the existing PWA routes (`POST /api/import/bbva`,
`GET /api/stats/mes-a-mes`) if you need the full UI payloads — still scoped
to the token's household via the acting member.

## PDF genéricos (IA)

Si el PDF no matchea el parser BBVA y está `OPENAI_API_KEY`, el import usa IA (`pdf_ai` / `statement_pdf`). Misma dedupe por `externalFingerprint`.

## Privacidad

Cuando conectás una IA por MCP, los movimientos salen de Tarask hacia esa IA. No pegues el token del hogar en chats ni en el repo. Polar/suscripción no se toca con este cambio.

## API de servicio (solo lectura)

Un caller servidor puede leer los datos de ese usuario por HTTP (`fetch`, incluso a través de un service binding). `lulox-mcp` no usa estas rutas: habla con el entrypoint `McpRpc` (sección de abajo). No usa la cookie de la PWA ni el token del hogar. La cookie sigue siendo la única auth de `/api/dashboard` y del resto de la PWA. El bearer de este secreto no autentica esas rutas.

Solo `GET`. Cualquier otro método en `/api/svc/*` responde `405`.

| Name | Required | Purpose |
| --- | --- | --- |
| `MCP_SERVICE_TOKEN` | sí | Secreto del Worker. Header `Authorization: Bearer <MCP_SERVICE_TOKEN>`. |
| `MCP_SERVICE_USER_EMAIL` | no | Email de `auth_user` al que actúa el servicio. Si falta, el email admin. |

```bash
wrangler secret put MCP_SERVICE_TOKEN
```

No commitees el valor. Si el secreto no está configurado, o el token falta o no coincide, la respuesta es `401` `{ "error": "No autenticado" }` sin decir cuál de los tres fue.

El servicio usa el hogar activo de ese usuario, con la misma regla que la PWA (cookie `lc_household` si viene, si no Personal / Mi espacio). Los números salen de las mismas funciones que el dashboard, la deuda, los ahorros, el patrimonio y el listado de movimientos.

| Método | Ruta | Qué devuelve |
| --- | --- | --- |
| GET | `/api/svc/resumen-mensual?from=YYYY-MM&to=YYYY-MM` | Por mes: ingresos y gastos en ARS, USD y total en pesos (gastos sin transferencias internas ni ecos, igual que el dashboard), neto y top 5 categorías. Default: últimos 6 meses, incluido el actual. Máximo 24. |
| GET | `/api/svc/deuda-ahorro-patrimonio` | Deuda (el `summary` de `/api/stats/deuda`), ahorros (el `summary` de `/api/ahorros`: ARS, USD, wallets y neto) y patrimonio (lo que devuelve `/api/patrimonio`, con la serie, `note`, `trustedMonths` y `changes` contra el mes anterior y el primer punto del año cuando hay datos). |
| GET | `/api/svc/ultimos-movimientos?limit=20` | Últimos movimientos del listado de Consumos. `limit` de 1 a 50 (default 20). `period=YYYY-MM` y `q` opcionales. Fecha, descripción, montos, categoría, banco, origen, pago y ownership. Sin tickets ni ids internos. |

`period` inválido, rango invertido o más de 24 meses: `400`.

```bash
curl -sS -H "Authorization: Bearer $MCP_SERVICE_TOKEN" \
  "$APP_URL/api/svc/resumen-mensual?from=2026-05&to=2026-10"

curl -sS -H "Authorization: Bearer $MCP_SERVICE_TOKEN" \
  "$APP_URL/api/svc/deuda-ahorro-patrimonio"

curl -sS -H "Authorization: Bearer $MCP_SERVICE_TOKEN" \
  "$APP_URL/api/svc/ultimos-movimientos?limit=20"
```

`$MCP_SERVICE_TOKEN` es un placeholder. No pegues el secreto en el repo, en un chat ni en el cliente MCP del navegador.

## McpRpc (solo service binding)

`lulox-mcp` llama a Tarask por un service binding de Cloudflare al entrypoint `McpRpc` (`worker/entry.ts`, clase que extiende `WorkerEntrypoint`). No es una ruta HTTP y no lee `Authorization`. El binding es el límite de confianza: no hace falta `MCP_SERVICE_TOKEN` y no hay secretos nuevos. El usuario es el de la API de servicio (`MCP_SERVICE_USER_EMAIL`, o el email admin si falta).

Cada método recibe un solo objeto y devuelve `{ ok: true, data }` o `{ ok: false, error: { code, message } }`. `code` es `no_owner`, `invalid`, `not_found`, `not_enabled` o `internal`. Un `internal` no incluye stack ni SQL. `data` es el mismo JSON que el GET de la tabla de arriba.

| Método | Argumento | Igual que |
| --- | --- | --- |
| `resumenMensual` | `{ from?: "YYYY-MM", to?: "YYYY-MM" }` | `GET /api/svc/resumen-mensual` |
| `deudaAhorroPatrimonio` | `{}` | `GET /api/svc/deuda-ahorro-patrimonio` |
| `ultimosMovimientos` | `{ limit?: 1..50, period?: "YYYY-MM", query?: string }` | `GET /api/svc/ultimos-movimientos`. `query` es el `q` del HTTP, de 1 a 200 caracteres. |

Si ese usuario no está en `auth_user`: `no_owner`. Mes inválido, rango invertido, más de 24 meses o `limit` fuera de 1..50: `invalid`, con las mismas reglas que el HTTP.
