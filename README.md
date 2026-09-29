# Chataliza 💬

**Analiza tu chat de WhatsApp sin que salga de tu navegador.** 100% local, privado y gratis.

🔗 **En vivo:** https://chataliza.pages.dev

Exporta un chat de WhatsApp y Chataliza te muestra quién escribe más, a qué horas, los emojis y palabras más usados, rachas y más — con una tarjeta lista para compartir. **Nada se sube a ningún servidor:** todo el análisis ocurre en tu dispositivo.

## Privacidad de verdad
El archivo del chat nunca sale de tu navegador. No hay backend, no hay cuentas y no hay analítica que toque tus datos. Puedes comprobarlo tú mismo en la pestaña «Red» de las herramientas de desarrollador.

## Cómo funciona
1. En WhatsApp: abre un chat → **Exportar chat → Sin archivos multimedia**.
2. Arrastra el `.txt` o el `.zip` a la web.
3. Mira tus estadísticas y descarga la tarjeta-resumen.

## Tecnología
Web estática (HTML + CSS + JavaScript), **sin frameworks ni dependencias pesadas**. Parsea el export de WhatsApp (`.txt` y `.zip`, este último descomprimido en el navegador con `DecompressionStream`, sin librerías) y genera las métricas y gráficas en el cliente.

## Licencia
El código fuente está bajo licencia [MIT](public/LICENSE). La marca «Chataliza», los textos y el diseño quedan reservados.

---
Hecho por [Santiago Reguero](https://santiago-off.github.io). No afiliado a WhatsApp ni a Meta; «WhatsApp» es una marca de Meta Platforms, Inc.
