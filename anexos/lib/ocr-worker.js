// Lector OCR local: corre en el navegador y no envía nada a ningún servidor.
let Mod = null;
let api = null;

const SIMD = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);

async function init(base) {
  const core = WebAssembly.validate(SIMD) ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
  importScripts(base + core);
  Mod = await TesseractCore({ print() {}, printErr() {} });
  const res = await fetch(base + 'spa-traineddata.txt');
  if (!res.ok) throw new Error('No se pudo cargar el idioma español (' + res.status + ')');
  const bin = atob((await res.text()).trim());
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  Mod.FS.writeFile('spa.traineddata', data);
  api = new Mod.TessBaseAPI();
  if (api.Init(null, 'spa', 1) === -1) throw new Error('No se pudo iniciar el lector');
  api.SetVariable('tessedit_pageseg_mode', '6');
}

function recognize(png) {
  Mod.FS.writeFile('/input', new Uint8Array(png));
  if (api.SetImageFile(1, 0) === 1) throw new Error('No se pudo leer la imagen');
  api.Recognize(null);
  const text = api.GetUTF8Text();
  const words = [];
  const ri = api.GetIterator();
  ri.Begin();
  do {
    const box = ri.getBoundingBox(Mod.RIL_WORD);
    words.push({
      t: ri.GetUTF8Text(Mod.RIL_WORD),
      c: ri.Confidence(Mod.RIL_WORD),
      x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1,
    });
  } while (ri.Next(Mod.RIL_WORD));
  Mod.destroy(ri);
  api.Clear();
  return { text, words };
}

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') { await init(m.base); self.postMessage({ id: m.id, ok: true }); return; }
    self.postMessage({ id: m.id, ok: true, result: recognize(m.png) });
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) });
  }
};
