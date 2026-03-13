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
let queue = Promise.resolve();

/* ----------- UTILS ----------- */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ----------- SESION SUNAT ----------- */

async function obtenerSesion() {
  console.log("[SESION] Obteniendo nueva sesión de SUNAT...");
  const startTime = Date.now();

  await execFileAsync("curl", [
    "-s",
    "-c", COOKIE_FILE,
    "-b", COOKIE_FILE,
    "-H", `User-Agent: ${UA}`,
    "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "-H", "Accept-Language: es-PE,es;q=0.9,en;q=0.8",
    "https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/FrameCriterioBusquedaWeb.jsp",
  ]);

  sessionTime = Date.now();
  const elapsed = Date.now() - startTime;
  console.log(`[SESION] Sesión obtenida en ${elapsed}ms`);
}

/* ----------- SCRAPER ----------- */

async function consultarRucPorDni(dni) {
  const reqId = ++requestCount;
  console.log(`[CONSULTA #${reqId}] Iniciando consulta para DNI: ${dni}`);
  const startTime = Date.now();

  try {
    // Paso 1: Obtener sesión solo si es necesario
    const sessionAge = sessionTime ? ((Date.now() - sessionTime) / 1000).toFixed(1) : 'N/A';
    console.log(`[CONSULTA #${reqId}] Sesión edad: ${sessionAge}s`);

    if (!sessionTime || Date.now() - sessionTime > SESSION_TTL) {
      console.log(`[CONSULTA #${reqId}] Sesión expirada, renovando...`);
      await obtenerSesion();
    } else {
      console.log(`[CONSULTA #${reqId}] Reutilizando sesión existente`);
    }

    // Paso 2: Consultar RUC (con reintento si SUNAT devuelve error)
    const MAX_RETRIES = 2;
    for (let intento = 1; intento <= MAX_RETRIES; intento++) {
      console.log(`[CONSULTA #${reqId}] Enviando POST a SUNAT (intento ${intento}/${MAX_RETRIES})...`);
      const { stdout: html } = await execFileAsync("curl", [
        "-s",
        "-b", COOKIE_FILE,
        "-c", COOKIE_FILE,
        "-H", `User-Agent: ${UA}`,
        "-H", "Referer: https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/FrameCriterioBusquedaWeb.jsp",
        "-H", "Content-Type: application/x-www-form-urlencoded",
        "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "-d", `accion=consPorTipdoc&tipdoc=1&nrodoc=${dni}&contexto=ti-it&modo=1&token=&search1=&search2=&search3=&nroRuc=&razSoc=`,
        "https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/jcrS00Alias",
      ]);

      const fetchElapsed = Date.now() - startTime;
      console.log(
        `[CONSULTA #${reqId}] Respuesta SUNAT: ${fetchElapsed}ms | HTML: ${html.length} chars`
      );

      // Detectar páginas de error de SUNAT
      const esError = html.includes("Pagina de Error") ||
                       html.includes("Request Rejected") ||
                       html.length < 500;

      if (esError && intento < MAX_RETRIES) {
        console.warn(
          `[CONSULTA #${reqId}] ⚠ SUNAT devolvió página de error, renovando sesión y reintentando...`
        );
        sessionTime = 0; // forzar nueva sesión
        await obtenerSesion();
        continue;
      }

      const $ = cheerio.load(html);

      const headings = $("h4.list-group-item-heading");
      const textos = $("p.list-group-item-text");

      const ruc = headings.eq(0).text().replace("RUC:", "").trim() || null;
      const nombre = headings.eq(1).text().trim() || null;
      const ubicacion =
        textos.eq(0).text().replace("Ubicación:", "").trim() || null;
      const estado = textos.eq(1).find("span").text().trim() || null;

      const totalElapsed = Date.now() - startTime;

      if (!ruc) {
        console.warn(
          `[CONSULTA #${reqId}] ⚠ Sin resultados para DNI: ${dni} | ${totalElapsed}ms`
        );
        return null;
      }

      console.log(
        `[CONSULTA #${reqId}] ✔ Resultado: RUC=${ruc} | Nombre=${nombre} | Estado=${estado} | ${totalElapsed}ms`
      );
      return { ruc, nombre, ubicacion, estado };
    }
    return null;
  } catch (error) {
    const totalElapsed = Date.now() - startTime;
    console.error(
      `[CONSULTA #${reqId}] ✖ Error: ${error.message} | ${totalElapsed}ms`
    );
    return null;
  }
}

/* ----------- COLA ----------- */

function encolarConsulta(fn) {
  console.log(`[COLA] Nueva consulta encolada`);
  const enqueueTime = Date.now();

  const result = queue.then(async () => {
    const waitTime = Date.now() - enqueueTime;
    console.log(`[COLA] Ejecutando consulta (esperó ${waitTime}ms en cola)`);
    const data = await fn();
    return data;
  });

  // El delay va DESPUÉS de resolver la promesa del resultado,
  // así no bloquea la respuesta actual
  queue = result
    .then(() => delay(DELAY_MS))
    .catch(() => delay(DELAY_MS));

  return result;
}

/* ----------- API ----------- */

app.get("/consulta/:dni", async (req, res) => {
  const { dni } = req.params;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`\n[API] ➜ GET /consulta/${dni} | IP: ${ip}`);

  if (!/^\d{8}$/.test(dni)) {
    console.warn(`[API] ✖ DNI inválido: ${dni}`);
    return res.status(400).json({ error: "El DNI debe tener 8 dígitos" });
  }

  const resultado = await encolarConsulta(() => consultarRucPorDni(dni));

  if (!resultado) {
    console.warn(`[API] ✖ 404 - Sin resultado para DNI: ${dni}`);
    return res
      .status(404)
      .json({ error: "No se encontró información para el DNI proporcionado" });
  }

  console.log(`[API] ✔ 200 - Respuesta enviada para DNI: ${dni}`);
  res.json(resultado);
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`  📅 Inicio: ${new Date().toISOString()}`);
  console.log(`  ⏱  Delay entre consultas: ${DELAY_MS}ms`);
  console.log(`========================================\n`);
});