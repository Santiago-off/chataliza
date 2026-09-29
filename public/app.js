/*
 * Chataliza — analizador de chats de WhatsApp, 100% en el navegador.
 *
 * Nada de lo que ocurre aquí sale de este dispositivo: no hay fetch(), no hay
 * XMLHttpRequest, no hay beacons. Solo File API, DecompressionStream (para
 * abrir el .zip nativamente) y Canvas (para dibujar la tarjeta de resumen).
 *
 * Estructura del archivo:
 *   1. Utilidades y constantes (formato, stopwords, patrones de sistema)
 *   2. Lectura de archivo (.txt directo / .zip mínimo con DecompressionStream)
 *   3. Parseo del export de WhatsApp en español
 *   4. Análisis y cálculo de métricas
 *   5. Render de resultados (barras/gráficas en HTML+CSS, sin librerías)
 *   6. Tarjeta-resumen descargable (canvas -> PNG)
 *   7. Cableado de la interfaz (dropzone, input, botones)
 */
(function () {
  "use strict";

  /* ============================================================
   * 1. Utilidades y constantes
   * ============================================================ */

  /** Error controlado: su .message ya está pensado para mostrarse al usuario. */
  class ChatalizaError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  const MAX_FILE_SIZE = 350 * 1024 * 1024; // 350 MB — guarda de cordura, un chat de texto real no llega ni de lejos
  const RESPONSE_MAX_MIN = 12 * 60; // no contamos como "respuesta" un hueco de más de 12h (probablemente otra conversación)
  const CHUNK_LINES = 20000; // líneas por lote antes de ceder el hilo principal

  const WEEKDAY_LABELS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
  const WEEKDAY_LABELS_SHORT = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

  // Emoji = cualquier carácter con la propiedad Unicode Extended_Pictographic.
  // No capturamos el selector de variación (️) aparte: no hace falta, va pegado al glyph.
  const EMOJI_RE = /\p{Extended_Pictographic}/gu;

  // Formatos reales del export de WhatsApp en español:
  //   [24/01/23, 14:03:05] Nombre: mensaje
  //   24/01/23, 14:03 - Nombre: mensaje
  // (WhatsApp normaliza espacios raros antes de esta función, ver normalizeText)
  const TIME_PART = "\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s?[ap]\\.?\\s?m\\.?)?";
  const RE_BRACKET = new RegExp("^\\[(\\d{1,2}/\\d{1,2}/\\d{2,4}),\\s(" + TIME_PART + ")\\]\\s(.*)$", "i");
  const RE_DASH = new RegExp("^(\\d{1,2}/\\d{1,2}/\\d{2,4}),\\s(" + TIME_PART + ")\\s-\\s(.*)$", "i");

  // "Nombre: mensaje" — el nombre no puede contener ':' ni salto de línea.
  const RE_SENDER_MESSAGE = /^([^\n:]+):\s([\s\S]*)$/;

  // Placeholders de multimedia / mensajes borrados: cuentan como mensaje, no como texto.
  const MEDIA_PATTERNS = [
    /^<multimedia omitido>$/i,
    /^imagen omitida\.?$/i,
    /^v(i|í)deo omitido\.?$/i,
    /^audio omitido\.?$/i,
    /^gif omitido\.?$/i,
    /^sticker omitido\.?$/i,
    /^documento omitido\.?$/i,
    /^contacto omitido\.?$/i,
    /^ubicaci(o|ó)n omitida\.?$/i,
    /^se elimin(o|ó) este mensaje\.?$/i,
    /^eliminaste este mensaje\.?$/i,
    /^este mensaje fue eliminado\.?$/i,
    /^llamada perdida/i,
    /^videollamada perdida/i,
  ];

  // Líneas de sistema conocidas (sin remitente real): las descartamos aunque,
  // por casualidad, contuvieran un ":" y pasaran el patrón Nombre: mensaje.
  const SYSTEM_LINE_PATTERNS = [
    /^los mensajes (y las llamadas )?est(a|á)n cifrad/i,
    /^.*cre(o|ó) (el|este) grupo/i,
    /^.*a(n|ñ)adi(o|ó) a /i,
    /^se a(n|ñ)adi(o|ó) a /i,
    /^.*sali(o|ó) del grupo/i,
    /^.*elimin(o|ó) a /i,
    /^.*cambi(o|ó) (el|la|su|tu) (asunto|(i|í)cono|descripci(o|ó)n|n(u|ú)mero)/i,
    /^tu c(o|ó)digo de seguridad con/i,
    /^.*ahora es administrador/i,
    /^.*ya no es administrador/i,
    /^.*se uni(o|ó) usando el enlace/i,
    /^.*te a(n|ñ)adi(o|ó)/i,
    /^los mensajes temporales est(a|á)n/i,
    /^se lleva un registro de/i,
  ];

  // Palabras vacías del español (artículos, preposiciones, pronombres…) que se
  // excluyen del ranking de palabras más usadas para que el top 20 diga algo.
  const STOPWORDS_ES = new Set(
    (
      "de la que el en y a los del se las por un para con no una su al lo como " +
      "más pero sus le ya o este sí porque esta entre cuando muy sin sobre también " +
      "me hasta hay donde quien desde todo nos durante todos uno les ni contra " +
      "otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras " +
      "otra él tanto esa estos mucho quienes nada muchos cual poco ella estar " +
      "estas algunas algo nosotros mi mis tú te ti tu tus ellas nosotras vosotros " +
      "vosotras os mío mía míos mías tuyo tuya tuyos tuyas suyo suya suyos suyas " +
      "nuestro nuestra nuestros nuestras vuestro vuestra vuestros vuestras esos " +
      "esas estoy estás está estamos estáis están es son fue era ser he has ha " +
      "hemos habéis han si un eres soy somos sea sean seas fui fueron será serán " +
      "voy vas va vamos van ir vez pues así aquí ahí allí bien mal así que porqué " +
      "cada sino según mientras aunque pueden puede podemos pueda tal cosa cosas " +
      "eh ah oh vale ok jaja jajaja jeje"
    )
      .split(/\s+/)
      .filter(Boolean)
  );

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatNumber(n) {
    return Math.round(n).toLocaleString("es-ES");
  }

  function formatDateShort(date) {
    return date.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function formatDateLong(date) {
    return date.toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });
  }

  function formatDuration(minutes) {
    if (minutes == null || Number.isNaN(minutes)) return "—";
    if (minutes < 1) return "< 1 min";
    if (minutes < 60) return Math.round(minutes) + " min";
    const hours = minutes / 60;
    if (hours < 24) return hours.toFixed(1).replace(".", ",") + " h";
    return (hours / 24).toFixed(1).replace(".", ",") + " d";
  }

  function toDateKey(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  function mondayIndex(jsDay) {
    // JS: 0=domingo..6=sábado -> queremos 0=lunes..6=domingo
    return jsDay === 0 ? 6 : jsDay - 1;
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /** Cede el control al navegador para que la pestaña siga respondiendo. */
  function yieldToMain() {
    return new Promise((resolve) => {
      if ("requestIdleCallback" in window) {
        requestIdleCallback(() => resolve(), { timeout: 50 });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  /** Quita marcas invisibles (LRM/RLM/BOM) y normaliza espacios raros de WhatsApp. */
  function normalizeText(raw) {
    return raw
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[‎‏﻿]/g, "")
      .replace(/[  ]/g, " ");
  }

  function normalizeToken(raw) {
    let w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!w) return null;
    if (/^https?:\/\//i.test(raw) || /^www\./i.test(raw)) return null;
    w = w.toLowerCase();
    if (/^\d+$/.test(w)) return null;
    if (w.length < 2) return null;
    if (STOPWORDS_ES.has(w)) return null;
    return w;
  }

  function isMediaPlaceholder(text) {
    const t = text.trim();
    return MEDIA_PATTERNS.some((re) => re.test(t));
  }

  function isSystemLine(text) {
    const t = text.trim();
    return SYSTEM_LINE_PATTERNS.some((re) => re.test(t));
  }

  /* ============================================================
   * 2. Lectura de archivo (.txt directo / .zip)
   * ============================================================ */

  /**
   * Lee el .txt del chat dentro de un .zip de WhatsApp SIN librerías externas:
   * parsea a mano el directorio central y la cabecera local (formato ZIP
   * estándar, sin ZIP64 — de sobra para un export de chat) y usa la API nativa
   * DecompressionStream('deflate-raw') del propio navegador para inflar los
   * bytes si hace falta. Cero dependencias, cero red.
   */
  async function readZipEntryText(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    const EOCD_SIG = 0x06054b50;

    let eocdOffset = -1;
    const minPos = Math.max(0, bytes.length - 65557); // 22 (EOCD) + 65535 (comentario máx.)
    for (let i = bytes.length - 22; i >= minPos; i--) {
      if (view.getUint32(i, true) === EOCD_SIG) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) {
      throw new ChatalizaError("zip-invalid", "No hemos podido leer el archivo .zip: no tiene el formato que genera WhatsApp.");
    }

    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);

    const CD_SIG = 0x02014b50;
    const entries = [];
    let ptr = cdOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (ptr + 46 > bytes.length || view.getUint32(ptr, true) !== CD_SIG) break;
      const compMethod = view.getUint16(ptr + 10, true);
      const compSize = view.getUint32(ptr + 20, true);
      const nameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const localHeaderOffset = view.getUint32(ptr + 42, true);
      const nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
      const name = new TextDecoder("utf-8").decode(nameBytes);
      entries.push({ name, compMethod, compSize, localHeaderOffset });
      ptr += 46 + nameLen + extraLen + commentLen;
    }

    const txtEntries = entries.filter((e) => /\.txt$/i.test(e.name) && !e.name.endsWith("/"));
    if (txtEntries.length === 0) {
      throw new ChatalizaError("zip-no-txt", "No hemos encontrado un chat de WhatsApp (un .txt) dentro de ese .zip.");
    }
    txtEntries.sort((a, b) => (/chat/i.test(a.name) ? 0 : 1) - (/chat/i.test(b.name) ? 0 : 1));
    const entry = txtEntries[0];

    const LFH_SIG = 0x04034b50;
    const lp = entry.localHeaderOffset;
    if (lp + 30 > bytes.length || view.getUint32(lp, true) !== LFH_SIG) {
      throw new ChatalizaError("zip-invalid", "El .zip parece dañado o no es un export estándar de WhatsApp.");
    }
    const lNameLen = view.getUint16(lp + 26, true);
    const lExtraLen = view.getUint16(lp + 28, true);
    const dataStart = lp + 30 + lNameLen + lExtraLen;
    const compData = bytes.subarray(dataStart, dataStart + entry.compSize);

    if (entry.compMethod === 0) {
      return new TextDecoder("utf-8").decode(compData);
    }
    if (entry.compMethod === 8) {
      if (typeof DecompressionStream === "undefined") {
        throw new ChatalizaError(
          "zip-unsupported",
          "Tu navegador no sabe descomprimir este .zip. Actualiza Chrome, Edge o Firefox, o exporta el chat sin multimedia y sube el .txt directamente."
        );
      }
      const stream = new Blob([compData]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(stream).text();
    }
    throw new ChatalizaError(
      "zip-unsupported",
      "Este .zip usa un método de compresión que no soportamos. Exporta el chat sin multimedia y sube el .txt directamente."
    );
  }

  /* ============================================================
   * 3. Parseo del export de WhatsApp
   * ============================================================ */

  /**
   * Convierte el texto exportado en una lista de mensajes reales.
   * Procesa por lotes (CHUNK_LINES) cediendo el hilo principal entre cada uno
   * para no bloquear la pestaña con archivos muy grandes.
   */
  async function parseChat(rawText, onProgress) {
    const text = normalizeText(rawText);
    const lines = text.split("\n");

    // Paso 1: agrupar líneas en "entradas" (una por mensaje o notificación),
    // uniendo las líneas de continuación de mensajes multilínea.
    const entries = [];
    let current = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m = RE_BRACKET.exec(line);
      let rest;
      if (m) {
        rest = m[3];
      } else {
        m = RE_DASH.exec(line);
        rest = m ? m[3] : null;
      }
      if (m) {
        if (current) entries.push(current);
        current = { dateStr: m[1], timeStr: m[2], rest };
      } else if (current) {
        current.rest += "\n" + line;
      }
      // si aún no hay "current" (líneas sueltas antes del primer mensaje), se ignoran

      if (i % CHUNK_LINES === 0) {
        if (onProgress) onProgress((i / Math.max(1, lines.length)) * 45);
        await yieldToMain();
      }
    }
    if (current) entries.push(current);

    // Paso 2: separar remitente/mensaje y descartar líneas de sistema.
    const messages = [];
    let systemCount = 0;
    let invalidCount = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const date = parseDateTime(e.dateStr, e.timeStr);
      if (!date) {
        invalidCount++;
        continue;
      }
      if (isSystemLine(e.rest)) {
        systemCount++;
        continue;
      }
      const sm = RE_SENDER_MESSAGE.exec(e.rest);
      if (!sm) {
        systemCount++;
        continue;
      }
      const sender = sm[1].trim();
      const msgText = sm[2];
      if (!sender) {
        systemCount++;
        continue;
      }
      messages.push({ date, sender, text: msgText, isMedia: isMediaPlaceholder(msgText) });

      if (i % CHUNK_LINES === 0) {
        if (onProgress) onProgress(45 + (i / Math.max(1, entries.length)) * 45);
        await yieldToMain();
      }
    }

    messages.sort((a, b) => a.date - b.date);
    if (onProgress) onProgress(90);
    return { messages, systemCount, invalidCount, totalLines: lines.length };
  }

  function parseDateTime(dateStr, timeStr) {
    const dateParts = dateStr.split("/");
    if (dateParts.length !== 3) return null;
    const day = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10);
    let year = parseInt(dateParts[2], 10);
    if (dateParts[2].length <= 2) year += 2000;

    let t = timeStr.trim();
    let ampm = null;
    const ampmMatch = /([ap])\.?\s?m\.?/i.exec(t);
    if (ampmMatch) {
      ampm = ampmMatch[1].toLowerCase();
      t = (t.slice(0, ampmMatch.index) + t.slice(ampmMatch.index + ampmMatch[0].length)).trim();
    }
    const timeParts = t.split(":").map((p) => parseInt(p, 10));
    if (timeParts.length < 2 || timeParts.some(Number.isNaN)) return null;
    let [hour, minute, second] = [timeParts[0], timeParts[1], timeParts[2] || 0];

    if (ampm === "p" && hour !== 12) hour += 12;
    if (ampm === "a" && hour === 12) hour = 0;

    if (
      day < 1 || day > 31 || month < 1 || month > 12 ||
      hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59
    ) {
      return null;
    }

    const date = new Date(year, month - 1, day, hour, minute, second);
    // Descarta fechas imposibles (p. ej. 31 de febrero) que Date() "redondearía" a otro mes.
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }

  /* ============================================================
   * 4. Análisis y cálculo de métricas
   * ============================================================ */

  async function analyze(messages, onProgress) {
    const perSender = new Map();
    const hourCounts = new Array(24).fill(0);
    const weekdayCounts = new Array(7).fill(0);
    const dayCounts = new Map(); // dateKey -> nº mensajes
    const firstSenderOfDay = new Map(); // dateKey -> remitente del primer mensaje
    const wordFreq = new Map();
    const emojiFreq = new Map();
    let rawWordTotal = 0;
    let totalEmojis = 0;
    let mediaCount = 0;

    function getSender(name) {
      let s = perSender.get(name);
      if (!s) {
        s = { sender: name, count: 0, words: 0, textMessages: 0, mediaMessages: 0, firstOfDay: 0, responseTimes: [] };
        perSender.set(name, s);
      }
      return s;
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const ps = getSender(msg.sender);
      ps.count++;

      const dateKey = toDateKey(msg.date);
      dayCounts.set(dateKey, (dayCounts.get(dateKey) || 0) + 1);
      if (!firstSenderOfDay.has(dateKey)) firstSenderOfDay.set(dateKey, msg.sender);

      hourCounts[msg.date.getHours()]++;
      weekdayCounts[mondayIndex(msg.date.getDay())]++;

      if (msg.isMedia) {
        mediaCount++;
        ps.mediaMessages++;
      } else {
        const tokens = msg.text.split(/\s+/).filter(Boolean);
        rawWordTotal += tokens.length;
        ps.words += tokens.length;
        ps.textMessages++;
        for (const tok of tokens) {
          const norm = normalizeToken(tok);
          if (norm) wordFreq.set(norm, (wordFreq.get(norm) || 0) + 1);
        }
        const emojis = msg.text.match(EMOJI_RE) || [];
        totalEmojis += emojis.length;
        for (const em of emojis) emojiFreq.set(em, (emojiFreq.get(em) || 0) + 1);
      }

      // tiempo de respuesta: solo cuando cambia el remitente y el hueco es razonable
      if (i > 0) {
        const prev = messages[i - 1];
        if (prev.sender !== msg.sender) {
          const deltaMin = (msg.date - prev.date) / 60000;
          if (deltaMin >= 0 && deltaMin <= RESPONSE_MAX_MIN) {
            ps.responseTimes.push(deltaMin);
          }
        }
      }

      if (i % CHUNK_LINES === 0) {
        if (onProgress) onProgress((i / Math.max(1, messages.length)) * 100);
        await yieldToMain();
      }
    }

    // Quién abre la conversación más veces (primer mensaje del día)
    const earlyBirdTally = new Map();
    for (const sender of firstSenderOfDay.values()) {
      earlyBirdTally.set(sender, (earlyBirdTally.get(sender) || 0) + 1);
    }
    for (const [sender, count] of earlyBirdTally) {
      getSender(sender).firstOfDay = count;
    }

    // Día más activo
    let mostActiveDay = null;
    for (const [dateKey, count] of dayCounts) {
      if (!mostActiveDay || count > mostActiveDay.count) {
        mostActiveDay = { date: new Date(dateKey + "T00:00:00"), count };
      }
    }

    // Racha más larga de días consecutivos con actividad
    const sortedDateKeys = Array.from(dayCounts.keys()).sort();
    let longestStreak = sortedDateKeys.length ? 1 : 0;
    let streakStart = sortedDateKeys[0] || null;
    let streakEnd = sortedDateKeys[0] || null;
    if (sortedDateKeys.length) {
      let curLen = 1;
      let curStart = sortedDateKeys[0];
      for (let i = 1; i < sortedDateKeys.length; i++) {
        const prevD = new Date(sortedDateKeys[i - 1] + "T00:00:00");
        const curD = new Date(sortedDateKeys[i] + "T00:00:00");
        const diffDays = Math.round((curD - prevD) / 86400000);
        if (diffDays === 1) {
          curLen++;
        } else {
          curLen = 1;
          curStart = sortedDateKeys[i];
        }
        if (curLen > longestStreak) {
          longestStreak = curLen;
          streakStart = curStart;
          streakEnd = sortedDateKeys[i];
        }
      }
    }

    const totalMessages = messages.length;
    const overallResponseTimes = [];
    const personList = Array.from(perSender.values())
      .map((p) => ({
        sender: p.sender,
        count: p.count,
        pct: totalMessages ? (p.count / totalMessages) * 100 : 0,
        words: p.words,
        avgWordsPerMsg: p.textMessages ? p.words / p.textMessages : null,
        firstOfDay: p.firstOfDay,
        medianResponseMin: median(p.responseTimes),
      }))
      .sort((a, b) => b.count - a.count);

    for (const p of perSender.values()) overallResponseTimes.push(...p.responseTimes);

    const topEmojis = Array.from(emojiFreq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const topWords = Array.from(wordFreq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20);
    const topEarlyBird = personList.slice().sort((a, b) => b.firstOfDay - a.firstOfDay)[0] || null;

    return {
      totalMessages,
      mediaCount,
      textMessages: totalMessages - mediaCount,
      rawWordTotal,
      totalEmojis,
      personList,
      hourCounts,
      weekdayCounts,
      mostActiveDay,
      uniqueDays: dayCounts.size,
      streak: { longest: longestStreak, start: streakStart, end: streakEnd },
      topEmojis,
      topWords,
      topEarlyBird: topEarlyBird && topEarlyBird.firstOfDay > 0 ? topEarlyBird : null,
      medianResponseMin: median(overallResponseTimes),
      dateRange: { from: messages[0].date, to: messages[messages.length - 1].date },
    };
  }

  /* ============================================================
   * 5. Render de resultados
   * ============================================================ */

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function renderStatGrid(el, stats) {
    clear(el);
    const cards = [
      { value: formatNumber(stats.totalMessages), label: "Mensajes totales" },
      { value: formatNumber(stats.personList.length), label: "Personas en el chat" },
      { value: formatNumber(stats.rawWordTotal), label: "Palabras escritas" },
      { value: formatNumber(stats.totalEmojis), label: "Emojis usados" },
      {
        value: stats.streak.longest + (stats.streak.longest === 1 ? " día" : " días"),
        label: "Racha más larga con actividad seguida",
      },
      {
        value: stats.mostActiveDay ? formatNumber(stats.mostActiveDay.count) : "—",
        label: stats.mostActiveDay ? "Mensajes el " + formatDateLong(stats.mostActiveDay.date) : "Día más activo",
      },
      {
        value: stats.topEarlyBird ? stats.topEarlyBird.sender : "—",
        label: stats.topEarlyBird
          ? "Abre la conversación más veces (" + formatNumber(stats.topEarlyBird.firstOfDay) + " días)"
          : "Quién abre el día",
      },
      { value: formatDuration(stats.medianResponseMin), label: "Tiempo de respuesta típico" },
    ];
    for (const c of cards) {
      const div = document.createElement("div");
      div.className = "stat-card";
      const b = document.createElement("b");
      b.textContent = c.value;
      const span = document.createElement("span");
      span.textContent = c.label;
      div.append(b, span);
      el.appendChild(div);
    }
  }

  function renderBarList(el, items, opts) {
    opts = opts || {};
    clear(el);
    if (!items.length) {
      const p = document.createElement("p");
      p.style.cssText = "color:var(--ink-mute);font-size:13.5px;margin:0";
      p.textContent = "No hay datos suficientes para mostrar esto.";
      el.appendChild(p);
      return;
    }
    const max = Math.max.apply(null, items.map((i) => i.value)) || 1;
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "bar-row" + (opts.emojiStyle ? " bar-row--emoji" : "");

      const label = document.createElement("div");
      label.className = "bar-row__label";
      label.textContent = item.label;
      label.title = item.label;

      const track = document.createElement("div");
      track.className = "bar-row__track";
      const fill = document.createElement("div");
      fill.className = "bar-row__fill";
      fill.style.width = Math.max(4, (item.value / max) * 100) + "%";
      track.appendChild(fill);

      const value = document.createElement("div");
      value.className = "bar-row__value";
      value.textContent = item.display != null ? item.display : formatNumber(item.value);

      row.append(label, track, value);
      el.appendChild(row);
    }
  }

  function renderHourChart(barsEl, labelsEl, hourCounts) {
    clear(barsEl);
    clear(labelsEl);
    const max = Math.max.apply(null, hourCounts) || 1;
    hourCounts.forEach((count, hour) => {
      const bar = document.createElement("div");
      bar.className = "chart-hours__bar";
      bar.style.height = Math.max(2, (count / max) * 100) + "%";
      bar.title = pad2(hour) + ":00 — " + formatNumber(count) + " mensajes";
      barsEl.appendChild(bar);

      const label = document.createElement("span");
      label.textContent = hour % 3 === 0 ? hour : "";
      labelsEl.appendChild(label);
    });
  }

  function renderWeekChart(el, weekdayCounts) {
    clear(el);
    const max = Math.max.apply(null, weekdayCounts) || 1;
    weekdayCounts.forEach((count, i) => {
      const col = document.createElement("div");
      col.className = "chart-week__col";
      const val = document.createElement("span");
      val.className = "chart-week__value";
      val.textContent = formatNumber(count);
      const bar = document.createElement("div");
      bar.className = "chart-week__bar";
      bar.style.height = Math.max(2, (count / max) * 100) + "%";
      bar.title = WEEKDAY_LABELS[i] + ": " + formatNumber(count) + " mensajes";
      const label = document.createElement("span");
      label.className = "chart-week__label";
      label.textContent = WEEKDAY_LABELS_SHORT[i];
      col.append(val, bar, label);
      el.appendChild(col);
    });
  }

  function renderPeopleTable(tbody, personList) {
    clear(tbody);
    for (const p of personList) {
      const tr = document.createElement("tr");
      const values = [
        p.sender,
        formatNumber(p.count),
        p.pct.toFixed(1) + "%",
        formatNumber(p.words),
        p.avgWordsPerMsg != null ? p.avgWordsPerMsg.toFixed(1) : "—",
        formatNumber(p.firstOfDay),
        formatDuration(p.medianResponseMin),
      ];
      values.forEach((v, idx) => {
        const td = document.createElement("td");
        if (idx > 0) td.className = "num";
        td.textContent = v;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  function renderResults(stats) {
    const resumen = document.getElementById("resumen-rango");
    clear(resumen);
    const strong1 = document.createElement("strong");
    strong1.textContent = formatNumber(stats.totalMessages);
    const strong2 = document.createElement("strong");
    strong2.textContent = formatDateShort(stats.dateRange.from);
    const strong3 = document.createElement("strong");
    strong3.textContent = formatDateShort(stats.dateRange.to);
    resumen.append(
      strong1,
      document.createTextNode(" mensajes entre "),
      strong2,
      document.createTextNode(" y "),
      strong3,
      document.createTextNode(
        " — " + formatNumber(stats.uniqueDays) + " días con actividad, entre " + formatNumber(stats.personList.length) + " personas."
      )
    );

    renderStatGrid(document.getElementById("stat-grid"), stats);

    renderBarList(
      document.getElementById("bar-personas"),
      stats.personList.map((p) => ({ label: p.sender, value: p.count, display: formatNumber(p.count) + " · " + p.pct.toFixed(1) + "%" }))
    );

    renderHourChart(document.getElementById("chart-horas"), document.getElementById("chart-horas-labels"), stats.hourCounts);
    renderWeekChart(document.getElementById("chart-semana"), stats.weekdayCounts);

    document.getElementById("nota-emojis").textContent =
      stats.totalEmojis > 0 ? formatNumber(stats.totalEmojis) + " emojis en total." : "No hemos detectado emojis en este chat.";
    renderBarList(
      document.getElementById("bar-emojis"),
      stats.topEmojis.map(([emoji, count]) => ({ label: emoji, value: count, display: formatNumber(count) })),
      { emojiStyle: true }
    );
    renderBarList(
      document.getElementById("bar-palabras"),
      stats.topWords.map(([word, count]) => ({ label: word, value: count, display: formatNumber(count) }))
    );

    renderPeopleTable(document.querySelector("#tabla-personas tbody"), stats.personList);

    drawShareCard(document.getElementById("tarjeta-canvas"), stats);
  }

  /* ============================================================
   * 6. Tarjeta-resumen descargable (canvas -> PNG)
   * ============================================================ */

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function truncateToWidth(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
    return t + "…";
  }

  const FONT = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  function drawShareCard(canvas, stats) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;

    // fondo degradado de marca
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#4F46E5");
    grad.addColorStop(1, "#06B6D4");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // círculos decorativos suaves
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = "#ffffff";
    const dots = [
      [W * 0.85, H * 0.1, 160],
      [W * 0.1, H * 0.9, 200],
      [W * 0.9, H * 0.85, 120],
    ];
    for (const [cx, cy, r] of dots) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // panel blanco
    const pad = 48;
    roundRectPath(ctx, pad, pad, W - pad * 2, H - pad * 2, 32);
    ctx.fillStyle = "rgba(255,255,255,0.97)";
    ctx.fill();

    const left = pad + 46;
    const maxTextWidth = W - pad * 2 - 92;

    ctx.textBaseline = "alphabetic";

    ctx.font = "700 40px " + FONT;
    ctx.fillStyle = "#4F46E5";
    ctx.fillText("💬 Chataliza", left, pad + 88);

    ctx.font = "500 25px " + FONT;
    ctx.fillStyle = "#475569";
    ctx.fillText("Mi chat de WhatsApp en cifras", left, pad + 126);

    // cifra grande: mensajes totales (con tamaño adaptable si el número es enorme)
    let bigSize = 118;
    ctx.font = "800 " + bigSize + "px " + FONT;
    const bigText = formatNumber(stats.totalMessages);
    while (bigSize > 60 && ctx.measureText(bigText).width > maxTextWidth) {
      bigSize -= 6;
      ctx.font = "800 " + bigSize + "px " + FONT;
    }
    ctx.fillStyle = "#0F172A";
    ctx.fillText(bigText, left, pad + 300);

    ctx.font = "600 27px " + FONT;
    ctx.fillStyle = "#64748B";
    ctx.fillText("mensajes analizados", left, pad + 338);

    // filas secundarias
    const topSender = stats.personList[0];
    const rows = [
      ["Persona que más escribe", topSender ? topSender.sender + " · " + topSender.pct.toFixed(0) + "%" : "—"],
      ["Día más activo", stats.mostActiveDay ? formatDateShort(stats.mostActiveDay.date) : "—"],
      ["Racha más larga", stats.streak.longest + (stats.streak.longest === 1 ? " día seguido" : " días seguidos")],
      ["Emoji más usado", stats.topEmojis[0] ? stats.topEmojis[0][0] + "  ·  " + formatNumber(stats.topEmojis[0][1]) : "—"],
    ];

    let y = pad + 410;
    for (const [label, value] of rows) {
      ctx.font = "700 22px " + FONT;
      ctx.fillStyle = "#94A3B8";
      ctx.fillText(label.toUpperCase(), left, y);

      ctx.font = "700 36px " + FONT;
      ctx.fillStyle = "#0F172A";
      ctx.fillText(truncateToWidth(ctx, String(value), maxTextWidth), left, y + 42);

      y += 98;
    }

    ctx.font = "600 21px " + FONT;
    ctx.fillStyle = "#94A3B8";
    ctx.fillText("Generado gratis en Chataliza — sin subir nada a internet", left, H - pad - 28);
  }

  function downloadShareCard() {
    const canvas = document.getElementById("tarjeta-canvas");
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "chataliza-resumen.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, "image/png");
  }

  /* ============================================================
   * 7. Cableado de la interfaz
   * ============================================================ */

  function showProgress(text, pct) {
    const progressBox = document.getElementById("status-progress");
    const errorBox = document.getElementById("status-error");
    if (errorBox) errorBox.classList.remove("is-visible");
    if (!progressBox) return;
    progressBox.classList.add("is-visible");
    document.getElementById("status-progress-text").textContent = text;
    document.getElementById("progress-fill").style.width = Math.min(100, Math.max(0, pct)) + "%";
  }

  function hideStatus() {
    const progressBox = document.getElementById("status-progress");
    if (progressBox) progressBox.classList.remove("is-visible");
  }

  function showError(message) {
    hideStatus();
    const box = document.getElementById("status-error");
    if (!box) return;
    box.classList.add("is-visible");
    document.getElementById("status-error-text").textContent = message;
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function showResultsSection() {
    const sec = document.getElementById("resultados");
    sec.classList.add("is-visible");
    sec.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function hideResultsSection() {
    const sec = document.getElementById("resultados");
    if (sec) sec.classList.remove("is-visible");
  }

  async function handleFile(file) {
    if (!file) return;
    hideResultsSection();

    const name = (file.name || "").toLowerCase();
    const isZip = name.endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
    const isTxt = name.endsWith(".txt") || file.type === "text/plain";

    if (!isZip && !isTxt) {
      showError("Ese archivo no lo reconocemos. Sube el .txt que exporta WhatsApp, o el .zip tal cual te lo manda la app.");
      return;
    }
    if (file.size === 0) {
      showError("El archivo está vacío.");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      showError("El archivo es demasiado grande para analizarlo en el navegador (más de 350 MB). Prueba a exportar el chat sin archivos multimedia.");
      return;
    }

    try {
      showProgress("Leyendo el archivo…", 5);
      let text;
      if (isZip) {
        showProgress("Descomprimiendo el .zip…", 15);
        const buf = await file.arrayBuffer();
        text = await readZipEntryText(buf);
      } else {
        text = await file.text();
      }

      if (!text || !text.trim()) {
        throw new ChatalizaError("empty", "El archivo está vacío o no hemos podido leerlo como texto.");
      }

      showProgress("Buscando mensajes…", 30);
      const parsed = await parseChat(text, (p) => showProgress("Analizando el chat…", 30 + p * 0.4));

      if (parsed.messages.length === 0) {
        throw new ChatalizaError(
          "no-messages",
          "No hemos reconocido ningún mensaje en este archivo. Comprueba que es la exportación de un chat de WhatsApp en español y que no se ha modificado su formato."
        );
      }

      showProgress("Calculando estadísticas…", 75);
      const stats = await analyze(parsed.messages, (p) => showProgress("Calculando estadísticas…", 75 + p * 0.2));

      showProgress("Listo", 100);
      renderResults(stats);
      hideStatus();
      showResultsSection();
    } catch (err) {
      hideStatus();
      if (err instanceof ChatalizaError) {
        showError(err.message);
      } else {
        console.error(err);
        showError("Algo ha fallado analizando el archivo. Comprueba que es un export de WhatsApp sin modificar y vuelve a intentarlo.");
      }
    }
  }

  function setupDropzone() {
    const dropzone = document.getElementById("dropzone");
    const fileInput = document.getElementById("file-input");
    const heroBtn = document.getElementById("btn-analizar-hero");
    if (!dropzone || !fileInput) return;

    if (heroBtn) heroBtn.addEventListener("click", () => fileInput.click());

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });

    ["dragenter", "dragover"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add("is-dragover");
      })
    );
    ["dragleave", "drop"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove("is-dragover");
      })
    );
    dropzone.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    fileInput.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) handleFile(f);
    });

    const btnReiniciar = document.getElementById("btn-reiniciar");
    if (btnReiniciar) {
      btnReiniciar.addEventListener("click", () => {
        hideResultsSection();
        fileInput.value = "";
        dropzone.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }

    const btn1 = document.getElementById("btn-descargar-tarjeta");
    const btn2 = document.getElementById("btn-descargar-tarjeta-2");
    if (btn1) btn1.addEventListener("click", downloadShareCard);
    if (btn2) btn2.addEventListener("click", downloadShareCard);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupDropzone);
  } else {
    setupDropzone();
  }
})();
