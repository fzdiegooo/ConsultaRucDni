import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();

app.use(
  cors({
    origin: ["https://fruticola.vercel.app", "http://localhost:3000"],
  })
);

const PORT = 4000;

let cookie = null;
let cookieTime = 0;

/* ----------- CONFIG ----------- */

const DELAY_MS = 1000; // 1.2s entre consultas
let queue = Promise.resolve();

/* ----------- UTILS ----------- */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ----------- SESION SUNAT ----------- */

async function obtenerSesion() {
  const res = await fetch(
    "https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/FrameCriterioBusquedaWeb.jsp"
  );

  cookie = res.headers.get("set-cookie");
  cookieTime = Date.now();
}

/* ----------- SCRAPER ----------- */

async function consultarRucPorDni(dni) {
  try {
    if (!cookie || Date.now() - cookieTime > 10 * 60 * 1000) {
      await obtenerSesion();
    }

    const res = await fetch(
      "https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/jcrS00Alias",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        },
        body: new URLSearchParams({
          accion: "consPorTipdoc",
          tipdoc: "1",
          nrodoc: dni,
        }),
      }
    );

    const html = await res.text();

    const $ = cheerio.load(html);

    const headings = $("h4.list-group-item-heading");
    const textos = $("p.list-group-item-text");

    const ruc = headings.eq(0).text().replace("RUC:", "").trim() || null;
    const nombre = headings.eq(1).text().trim() || null;
    const ubicacion =
      textos.eq(0).text().replace("Ubicación:", "").trim() || null;
    const estado = textos.eq(1).find("span").text().trim() || null;

    if (!ruc) return null;

    return { ruc, nombre, ubicacion, estado };
  } catch (error) {
    console.error("Error:", error.message);
    return null;
  }
}

/* ----------- COLA ----------- */

function encolarConsulta(fn) {
  const result = queue.then(async () => {
    const data = await fn();
    await delay(DELAY_MS);
    return data;
  });

  queue = result.catch(() => {}); // evita romper la cola
  return result;
}

/* ----------- API ----------- */

app.get("/consulta/:dni", async (req, res) => {
  const { dni } = req.params;

  if (!/^\d{8}$/.test(dni)) {
    return res.status(400).json({ error: "El DNI debe tener 8 dígitos" });
  }

  const resultado = await encolarConsulta(() => consultarRucPorDni(dni));

  if (!resultado) {
    return res
      .status(404)
      .json({ error: "No se encontró información para el DNI proporcionado" });
  }

  res.json(resultado);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});