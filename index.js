import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();

app.use(
  cors({
    origin: ["https://fruticola.vercel.app", "http://localhost:3000"],
  })
);

const PORT = 4000;

let requestCount = 0;
let sessionTime = 0;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const COOKIE_FILE = "/tmp/sunat_cookies.txt";
const SESSION_TTL = 10 * 60 * 1000; // 10 min

/* ----------- CONFIG ----------- */

const DELAY_MS = 1000;

// curl nunca debe quedarse colgado: una consulta lenta bloquea toda la cola.
const CURL_TIMEOUT = ["--connect-timeout", "5", "--max-time", "15"];
const EXEC_OPTS = { maxBuffer: 10 * 1024 * 1024 };

// Máximo de consultas esperando turno antes de rechazar con 503.
const MAX_QUEUE = 30;
// Si una consulta esperó más que esto, el cliente ya se rindió: no la ejecutamos.
const MAX_WAIT_MS = 20 * 1000;

// Cache por DNI. Los resultados negativos duran menos por si el RUC se da de alta.
const CACHE_TTL_OK = 6 * 60 * 60 * 1000; // 6 h
const CACHE_TTL_MISS = 10 * 60 * 1000; // 10 min
const CACHE_MAX_ENTRIES = 5000;

let queue = Promise.resolve();
let queueLength = 0;

const cache = new Map();
const inFlight = new Map();

class ColaLlenaError extends Error {
  constructor() {
    super("Cola saturada");
    this.name = "ColaLlenaError";
  }
}

class ConsultaExpiradaError extends Error {
  constructor(waitTime) {
    super(`Consulta descartada tras esperar ${waitTime}ms en cola`);
    this.name = "ConsultaExpiradaError";
  }
}

/* ----------- UTILS ----------- */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function limpiarTexto(texto = "") {
  return texto.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function extraerEstadoDesdeDetalle(htmlDetalle) {
  const $ = cheerio.load(htmlDetalle);
  let estadoDetalle = null;

  $(".list-group-item").each((_, item) => {
    const titulo = limpiarTexto(
      $(item).find("h4.list-group-item-heading").first().text()
    ).toUpperCase();

    if (titulo.includes("ESTADO DEL CONTRIBUYENTE")) {
      const textoEstado = limpiarTexto(
        $(item).find("p.list-group-item-text").first().text()
      );
      estadoDetalle = limpiarTexto(textoEstado.replace(/Fecha de Baja:.*/i, ""));
      return false;
    }
  });

  return estadoDetalle || null;
}

async function obtenerEstadoDetalleRuc({ ruc, numRnd, reqId }) {
  try {
    const postBody = new URLSearchParams({
      accion: "consPorRuc",
      actReturn: "1",
      nroRuc: ruc,
      numRnd: numRnd || "",
      modo: "1",
    }).toString();

    const { stdout: htmlDetalle } = await execFileAsync(
      "curl",
      [
        "-s",
        ...CURL_TIMEOUT,
        "-b", COOKIE_FILE,
        "-c", COOKIE_FILE,
        "-H", `User-Agent: ${UA}`,
        "-H", "Referer: https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/jcrS00Alias",
        "-H", "Content-Type: application/x-www-form-urlencoded",
        "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "-d", postBody,
        "https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/jcrS00Alias",
      ],
      EXEC_OPTS
    );

    const esError =
      htmlDetalle.includes("Pagina de Error") ||
      htmlDetalle.includes("Request Rejected") ||
      htmlDetalle.length < 1000;

    if (esError) {
      console.warn(
        `[CONSULTA #${reqId}] ⚠ No se pudo abrir detalle del RUC ${ruc} (respuesta inválida)`
      );
      return null;
    }

    const estadoDetalle = extraerEstadoDesdeDetalle(htmlDetalle);
    if (estadoDetalle) {
      console.log(
        `[CONSULTA #${reqId}] ✔ Estado desde detalle RUC ${ruc}: ${estadoDetalle}`
      );
    }

    return estadoDetalle;
  } catch (error) {
    console.warn(
      `[CONSULTA #${reqId}] ⚠ Error al consultar detalle del RUC ${ruc}: ${error.message}`
    );
    return null;
  }
}

/* ----------- SESION SUNAT ----------- */

async function obtenerSesion() {
  console.log("[SESION] Obteniendo nueva sesión de SUNAT...");
  const startTime = Date.now();

  await execFileAsync(
    "curl",
    [
      "-s",
      ...CURL_TIMEOUT,
      "-c", COOKIE_FILE,
      "-b", COOKIE_FILE,
      "-H", `User-Agent: ${UA}`,
      "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "-H", "Accept-Language: es-PE,es;q=0.9,en;q=0.8",
      "https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/FrameCriterioBusquedaWeb.jsp",
    ],
    EXEC_OPTS
  );

  sessionTime = Date.now();
  const elapsed = Date.now() - startTime;
  console.log(`[SESION] Sesión obtenida en ${elapsed}ms`);
}

/* ----------- SCRAPER ----------- */

// Devuelve null cuando SUNAT respondió bien pero el DNI no tiene RUC.
// Lanza cuando SUNAT falló (timeout, WAF, error de red): eso no se cachea.
async function consultarRucPorDni(dni) {
  const reqId = ++requestCount;
  console.log(`[CONSULTA #${reqId}] Iniciando consulta para DNI: ${dni}`);
  const startTime = Date.now();

  // Paso 1: Obtener sesión solo si es necesario
  const sessionAge = sessionTime
    ? ((Date.now() - sessionTime) / 1000).toFixed(1)
    : "N/A";
  console.log(`[CONSULTA #${reqId}] Sesión edad: ${sessionAge}s`);

  if (!sessionTime || Date.now() - sessionTime > SESSION_TTL) {
    console.log(`[CONSULTA #${reqId}] Sesión expirada, renovando...`);
    await obtenerSesion();
  } else {
    console.log(`[CONSULTA #${reqId}] Reutilizando sesión existente`);
  }

  // Paso 2: Consultar RUC (con reintento si SUNAT falla o devuelve error)
  const MAX_RETRIES = 2;
  for (let intento = 1; intento <= MAX_RETRIES; intento++) {
    console.log(
      `[CONSULTA #${reqId}] Enviando POST a SUNAT (intento ${intento}/${MAX_RETRIES})...`
    );

    let html;
    try {
      ({ stdout: html } = await execFileAsync(
        "curl",
        [
          "-s",
          ...CURL_TIMEOUT,
          "-b", COOKIE_FILE,
          "-c", COOKIE_FILE,
          "-H", `User-Agent: ${UA}`,
          "-H", "Referer: https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/FrameCriterioBusquedaWeb.jsp",
          "-H", "Content-Type: application/x-www-form-urlencoded",
          "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "-d", `accion=consPorTipdoc&tipdoc=1&nrodoc=${dni}&contexto=ti-it&modo=1&token=&search1=&search2=&search3=&nroRuc=&razSoc=`,
          "https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/jcrS00Alias",
        ],
        EXEC_OPTS
      ));
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.warn(
        `[CONSULTA #${reqId}] ⚠ curl falló (intento ${intento}/${MAX_RETRIES}) | ${elapsed}ms: ${error.message.split("\n")[0]}`
      );
      if (intento < MAX_RETRIES) {
        sessionTime = 0; // forzar nueva sesión
        await obtenerSesion();
        continue;
      }
      throw error;
    }

    const fetchElapsed = Date.now() - startTime;
    console.log(
      `[CONSULTA #${reqId}] Respuesta SUNAT: ${fetchElapsed}ms | HTML: ${html.length} chars`
    );

    // Detectar páginas de error de SUNAT
    const esError =
      html.includes("Pagina de Error") ||
      html.includes("Request Rejected") ||
      html.length < 500;

    if (esError) {
      if (intento < MAX_RETRIES) {
        console.warn(
          `[CONSULTA #${reqId}] ⚠ SUNAT devolvió página de error, renovando sesión y reintentando...`
        );
        sessionTime = 0; // forzar nueva sesión
        await obtenerSesion();
        continue;
      }
      throw new Error(
        `SUNAT devolvió página de error tras ${MAX_RETRIES} intentos`
      );
    }

    const $ = cheerio.load(html);

    const headings = $("h4.list-group-item-heading");
    const textos = $("p.list-group-item-text");

    const ruc = headings.eq(0).text().replace("RUC:", "").trim() || null;

    // Sin RUC no hay detalle que abrir: evita un POST extra a SUNAT en cada 404.
    if (!ruc) {
      console.warn(
        `[CONSULTA #${reqId}] ⚠ Sin resultados para DNI: ${dni} | ${Date.now() - startTime}ms`
      );
      return null;
    }

    const nombre = headings.eq(1).text().trim() || null;
    const ubicacion =
      textos.eq(0).text().replace("Ubicación:", "").trim() || null;
    const estadoResumen = textos.eq(1).find("span").text().trim() || null;

    const numRnd =
      $("form[name='selecXNroRuc'] input[name='numRnd']").attr("value") || "";
    const estadoDetalle = await obtenerEstadoDetalleRuc({ ruc, numRnd, reqId });
    const estado = estadoDetalle || estadoResumen;

    const totalElapsed = Date.now() - startTime;
    console.log(
      `[CONSULTA #${reqId}] ✔ Resultado: RUC=${ruc} | Nombre=${nombre} | Estado=${estado} | Estado resumen=${estadoResumen} | ${totalElapsed}ms`
    );
    return { ruc, nombre, ubicacion, estado };
  }

  return null;
}

/* ----------- CACHE ----------- */

function leerCache(dni) {
  const hit = cache.get(dni);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    cache.delete(dni);
    return undefined;
  }
  return hit;
}

function guardarCache(dni, data) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const ahora = Date.now();
    for (const [clave, valor] of cache) {
      if (ahora > valor.expires) cache.delete(clave);
    }
    // Si sigue lleno, descarta la entrada más antigua (Map preserva orden de inserción).
    if (cache.size >= CACHE_MAX_ENTRIES) {
      cache.delete(cache.keys().next().value);
    }
  }

  cache.set(dni, {
    data,
    expires: Date.now() + (data ? CACHE_TTL_OK : CACHE_TTL_MISS),
  });
}

/* ----------- COLA ----------- */

function encolarConsulta(fn) {
  if (queueLength >= MAX_QUEUE) {
    console.warn(`[COLA] ✖ Cola llena (${queueLength}), rechazando consulta`);
    throw new ColaLlenaError();
  }

  queueLength++;
  console.log(`[COLA] Nueva consulta encolada (${queueLength} en cola)`);
  const enqueueTime = Date.now();

  const result = queue.then(() => {
    queueLength--;
    const waitTime = Date.now() - enqueueTime;

    // El cliente ya se rindió hace rato: no gastamos una petición a SUNAT.
    if (waitTime > MAX_WAIT_MS) {
      console.warn(
        `[COLA] ✖ Consulta descartada: esperó ${waitTime}ms (límite ${MAX_WAIT_MS}ms)`
      );
      throw new ConsultaExpiradaError(waitTime);
    }

    console.log(`[COLA] Ejecutando consulta (esperó ${waitTime}ms en cola)`);
    return fn();
  });

  // El delay va DESPUÉS de resolver la promesa del resultado,
  // así no bloquea la respuesta actual.
  queue = result.then(
    () => delay(DELAY_MS),
    () => delay(DELAY_MS)
  );

  return result;
}

// Cache + deduplicación: varias peticiones del mismo DNI comparten una sola
// consulta a SUNAT en vez de ocupar un turno de cola cada una.
function consultarConCache(dni) {
  const hit = leerCache(dni);
  if (hit) {
    console.log(`[CACHE] ✔ Hit para DNI: ${dni}`);
    return Promise.resolve(hit.data);
  }

  const enCurso = inFlight.get(dni);
  if (enCurso) {
    console.log(`[CACHE] ⏳ Consulta en curso para DNI: ${dni}, reutilizando`);
    return enCurso;
  }

  let promesa;
  try {
    promesa = encolarConsulta(() => consultarRucPorDni(dni));
  } catch (error) {
    return Promise.reject(error);
  }

  promesa = promesa
    .then((data) => {
      guardarCache(dni, data);
      return data;
    })
    .finally(() => inFlight.delete(dni));

  inFlight.set(dni, promesa);
  return promesa;
}

/* ----------- API ----------- */

app.get("/consulta/:dni", async (req, res) => {
  const { dni } = req.params;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[API] ➜ GET /consulta/${dni} | IP: ${ip}`);

  if (!/^\d{8}$/.test(dni)) {
    console.warn(`[API] ✖ DNI inválido: ${dni}`);
    return res.status(400).json({ error: "El DNI debe tener 8 dígitos" });
  }

  let resultado;
  try {
    resultado = await consultarConCache(dni);
  } catch (error) {
    if (error instanceof ColaLlenaError) {
      console.warn(`[API] ✖ 503 - Cola saturada para DNI: ${dni}`);
      return res
        .status(503)
        .set("Retry-After", "5")
        .json({ error: "Servicio saturado, reintenta en unos segundos" });
    }

    if (error instanceof ConsultaExpiradaError) {
      console.warn(`[API] ✖ 503 - Consulta expirada en cola para DNI: ${dni}`);
      return res
        .status(503)
        .set("Retry-After", "5")
        .json({ error: "Servicio saturado, reintenta en unos segundos" });
    }

    console.error(`[API] ✖ 502 - SUNAT no respondió para DNI: ${dni}: ${error.message.split("\n")[0]}`);
    return res
      .status(502)
      .json({ error: "SUNAT no respondió correctamente, reintenta más tarde" });
  }

  if (!resultado) {
    console.warn(`[API] ✖ 404 - Sin resultado para DNI: ${dni}`);
    return res
      .status(404)
      .json({ error: "No se encontró información para el DNI proporcionado" });
  }

  console.log(`[API] ✔ 200 - Respuesta enviada para DNI: ${dni}`);
  res.json(resultado);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    enCola: queueLength,
    enVuelo: inFlight.size,
    cache: cache.size,
    consultas: requestCount,
    sesionEdadSegundos: sessionTime
      ? Number(((Date.now() - sessionTime) / 1000).toFixed(1))
      : null,
  });
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`  📅 Inicio: ${new Date().toISOString()}`);
  console.log(`  ⏱  Delay entre consultas: ${DELAY_MS}ms`);
  console.log(`  ⏱  Timeout curl: ${CURL_TIMEOUT.join(" ")}`);
  console.log(`  📥 Cola máx: ${MAX_QUEUE} | espera máx: ${MAX_WAIT_MS}ms`);
  console.log(`  🗄  Cache TTL: ${CACHE_TTL_OK / 60000}min OK / ${CACHE_TTL_MISS / 60000}min 404`);
  console.log(`========================================\n`);
});
