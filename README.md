# mcp-gsc

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jsgm/mcp-gsc)

Servidor MCP remoto de **Google Search Console** sobre **Cloudflare Workers**, para usarlo desde Claude y ChatGPT (web, escritorio y Claude Code).

- **Una cuenta de servicio por despliegue**, con acceso a todas las propiedades en las que la añadas.
- **OAuth + Cloudflare Access**: Claude y ChatGPT se conectan por OAuth (lo único que admiten sus conectores) y Cloudflare Access decide quién puede iniciar sesión.
- **Solo lectura**, sin Docker ni servidores: `wrangler deploy` y listo.

## Cómo funciona

```
Claude / ChatGPT ──OAuth 2.1──▶ Worker ──JWT de la cuenta de servicio──▶ API de Search Console
                                  │
                                  └─ login (solo en el navegador) ──▶ Cloudflare Access (OIDC)
```

1. Añades `https://<tu-worker>/mcp` como conector OAuth en Claude o ChatGPT.
2. Se abre una página de confirmación del Worker y, después, el login de Cloudflare Access (código por email, Google, GitHub…).
3. Si tu email está permitido en Access, el Worker emite sus propios tokens al cliente MCP.
4. Las herramientas consultan Search Console con la cuenta de servicio.

Cloudflare Access **no** se pone delante de `/mcp`: solo interviene en el login. El tráfico MCP lo protegen los tokens que emite el Worker ([`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)).

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `list_properties` | Propiedades a las que tiene acceso la cuenta de servicio |
| `get_search_analytics` | Clics, impresiones, CTR y posición por dimensiones, con filtros y fechas |
| `get_performance_overview` | Totales frente al periodo anterior y tendencia diaria |
| `compare_search_periods` | Dos periodos por consulta o página: mayores subidas, bajadas, nuevas y perdidas |
| `get_search_by_page_query` | Consultas de una URL, o URLs de una consulta |
| `inspect_url` | Estado de indexación, canonical, rastreo, robots.txt, móvil, resultados enriquecidos |
| `batch_url_inspection` | Hasta 20 URLs en una tabla resumen |
| `list_sitemaps` | Sitemaps enviados, errores, avisos y URLs enviadas |
| `get_sitemap_details` | Detalle de un sitemap |

La propiedad se puede indicar como `sc-domain:ejemplo.com`, `https://www.ejemplo.com/` o simplemente `ejemplo.com`; el servidor la resuelve contra las propiedades accesibles.

## Puesta en marcha

### 1. Cuenta de servicio de Google

1. En [Google Cloud Console](https://console.cloud.google.com/), crea o elige un proyecto.
2. **APIs y servicios → Biblioteca**, busca **Google Search Console API** y actívala.
3. **IAM y administración → Cuentas de servicio → Crear cuenta de servicio** (no necesita roles).
4. En la cuenta creada: **Claves → Agregar clave → JSON**. Guarda el archivo; no lo subas al repositorio.
5. En [Search Console](https://search.google.com/search-console), en **cada propiedad**: **Configuración → Usuarios y permisos → Añadir usuario**, con el email de la cuenta de servicio (`...@...iam.gserviceaccount.com`) y permiso **Restringido** (basta para leer) o **Completo**.

Para añadir una web más adelante solo repites el paso 5; no hay que tocar el Worker.

### 2. Aplicación de Cloudflare Access (OIDC)

La URL del Worker será `https://<nombre-del-worker>.<tu-subdominio>.workers.dev` (el nombre por defecto es `mcp-gsc`; tu subdominio aparece en **Workers & Pages** del panel de Cloudflare). Puedes crear la aplicación de Access antes de desplegar con esa URL prevista.

En el panel de **Cloudflare Zero Trust** (si es la primera vez, te pedirá elegir un nombre de equipo; el plan gratuito cubre hasta 50 usuarios):

1. **Access → Applications → Add an application → SaaS**.
2. Nombre: `mcp-gsc`. Protocolo de autenticación: **OIDC**.
3. **Redirect URLs**: `https://mcp-gsc.<tu-subdominio>.workers.dev/callback`
   (para desarrollo local añade también `http://localhost:8787/callback`).
4. **Scopes**: `openid`, `email`, `profile`.
5. Guarda y copia **Client ID**, **Client secret**, **Authorization endpoint**, **Token endpoint** y **Key endpoint** (JWKS).
6. **Policies**: crea una política *Allow* que incluya los emails (o el dominio) que pueden usar el servidor.
7. **Login methods**: elige los métodos (código de un solo uso por email, Google, GitHub…).

Los nombres exactos del panel pueden variar ligeramente según la versión de Zero Trust.

### 3. Desplegar

#### Opción A: botón "Deploy to Cloudflare" (recomendado)

1. Pulsa el botón del principio de este README.
2. Cloudflare copia el repositorio en tu GitHub o GitLab, crea el Worker, el KV y el Durable Object, y configura despliegues automáticos en cada push.
3. Te pedirá los 6 secrets, con una descripción de dónde sacar cada uno:
   - `GSC_SERVICE_ACCOUNT_JSON`: pega el contenido completo del JSON de la cuenta de servicio.
   - `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `CF_ACCESS_AUTHORIZATION_ENDPOINT`, `CF_ACCESS_TOKEN_ENDPOINT`, `CF_ACCESS_KEY_ENDPOINT`: los valores del paso 2.
4. Si cambias el nombre del Worker en el formulario, actualiza la Redirect URL de la aplicación de Access para que coincida.

Si aún no tienes la aplicación de Access, puedes poner `pendiente` en sus secrets y cambiarlos después en **Workers & Pages → mcp-gsc → Settings → Variables and Secrets**. El MCP no funcionará hasta entonces, porque el login depende de ellos.

#### Opción B: manual con Wrangler

```bash
git clone https://github.com/jsgm/mcp-gsc && cd mcp-gsc
npm install
npx wrangler login
npx wrangler deploy        # crea el KV automáticamente → https://mcp-gsc.<tu-subdominio>.workers.dev

npx wrangler secret put GSC_SERVICE_ACCOUNT_JSON < ruta/a/la-cuenta-de-servicio.json
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
npx wrangler secret put CF_ACCESS_AUTHORIZATION_ENDPOINT
npx wrangler secret put CF_ACCESS_TOKEN_ENDPOINT
npx wrangler secret put CF_ACCESS_KEY_ENDPOINT
```

Si tu versión de Wrangler no crea el KV automáticamente, créalo con `npx wrangler kv namespace create OAUTH_KV` y añade su `id` en `wrangler.jsonc`.

#### Opcional: lista extra de emails

`ALLOWED_EMAILS` (emails separados por comas), añadida como variable o secret del Worker, es una segunda lista de permitidos que comprueba el propio Worker además de la política de Access.

### 4. Conectar los clientes

**Claude (web o escritorio):** Ajustes → Conectores → *Añadir conector personalizado* → URL `https://mcp-gsc.<tu-subdominio>.workers.dev/mcp`. Al conectar se abrirá el login.

**ChatGPT:** Ajustes → Apps y conectores → Avanzado → activar *Modo desarrollador* → *Crear*, con la misma URL y autenticación **OAuth**. (Requiere un plan con modo desarrollador.)

**Claude Code:**

```bash
claude mcp add --transport http gsc https://mcp-gsc.<tu-subdominio>.workers.dev/mcp
```

Prueba con: *"Lista mis propiedades de Search Console"*.

## Un segundo despliegue (por ejemplo, personal)

Mismo código, otra cuenta de servicio y otro Worker:

Lo más sencillo es pulsar otra vez el botón "Deploy to Cloudflare" desde la cuenta de Cloudflare que corresponda, con otro nombre de Worker (p. ej. `mcp-gsc-personal`). A mano:

```bash
cp wrangler.jsonc wrangler.personal.jsonc   # cambia "name" (p. ej. mcp-gsc-personal)
npx wrangler deploy -c wrangler.personal.jsonc   # crea su propio KV
npx wrangler secret put GSC_SERVICE_ACCOUNT_JSON -c wrangler.personal.jsonc < personal.json
# ...resto de secrets con -c wrangler.personal.jsonc
```

Crea otra aplicación de Access (o añade su `/callback` a la existente) y conéctalo como otro conector. Lo recomendable es que cada credencial viva en la cuenta de Cloudflare de su dueño (empresa o personal).

## Desarrollo local

```bash
cp .dev.vars.example .dev.vars   # rellena los valores
npm run dev                      # http://localhost:8787
npx @modelcontextprotocol/inspector   # conecta a http://localhost:8787/mcp
```

## Seguridad

- **Solo lectura**: el scope de Google es `webmasters.readonly` y no hay herramientas que modifiquen nada.
- **La cuenta de servicio ve todo lo que tenga asignado**: cualquiera que pase el login de Access verá esas propiedades. Mantén la política de Access ajustada.
- **Página de confirmación**: el usuario aprueba cada nueva conexión antes del login, y el estado del login va ligado a una cookie del navegador, para evitar que otro sitio complete una autorización en tu nombre.
- **Quitar acceso a alguien**: elimínalo de la política de Access para impedir nuevos logins. Las conexiones ya autorizadas se guardan en KV (`OAUTH_KV`); para cortarlas al momento, borra sus grants (`npx wrangler kv key list --binding OAUTH_KV --prefix "grant:"` y `npx wrangler kv key delete`).
- **Logs**: cada llamada registra usuario, herramienta, duración y resultado (visible en *Workers → Logs*), sin datos de Search Console.

## Límites

- **Inspección de URLs**: unas 2.000 al día por propiedad (y 600 por minuto), según Google.
- **Search Analytics**: máximo 25.000 filas por petición; datos de los últimos 16 meses, con 2–3 días de retraso.
- **Plan gratuito de Workers**: unas 50 subpeticiones por invocación; suficiente para todas las herramientas tal como están (la inspección por lotes se limita a 20 URLs).

## Licencia

MIT
