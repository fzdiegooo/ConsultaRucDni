import { chromium } from 'playwright';
import express from 'express';

const app = express();
const PORT = 4000;

async function consultarRucPorDni(dni) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'es-PE',
  });
  const page = await context.newPage();

  try {
    await page.goto('https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/FrameCriterioBusquedaWeb.jsp');
    await page.click('#btnPorDocumento');
    await page.fill('#txtNumeroDocumento', dni);
    await page.click('#btnAceptar');

    await page.waitForSelector('.aRucs', { timeout: 6000 });

    const resultado = await page.$eval('.aRucs', (el) => {
      const headings = el.querySelectorAll('h4.list-group-item-heading');
      const textos = el.querySelectorAll('p.list-group-item-text');

      const rucText = headings[0]?.textContent?.replace('RUC:', '').trim() || null;
      const nombre = headings[1]?.textContent?.trim() || null;
      const ubicacion = textos[0]?.textContent?.replace('Ubicación:', '').trim() || null;
      const estado = textos[1]?.querySelector('span')?.textContent?.trim() || null;

      return { ruc: rucText, nombre, ubicacion, estado };
    });

    return resultado;
  } catch (error) {
    console.error('Error:', error.message);
    return null;
  } finally {
    await browser.close();
  }
}

app.get('/consulta/:dni', async (req, res) => {
  const { dni } = req.params;

  if (!/^\d{8}$/.test(dni)) {
    return res.status(400).json({ error: 'El DNI debe tener 8 dígitos' });
  }

  const resultado = await consultarRucPorDni(dni);

  if (!resultado) {
    return res.status(404).json({ error: 'No se encontró información para el DNI proporcionado' });
  }

  res.json(resultado);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
