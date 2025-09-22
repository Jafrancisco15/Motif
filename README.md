# Mentor Coffee Scale • Web Bluetooth (Vercel Ready)

Lectura en tiempo real de la balanza Motif/Mentor vía Web Bluetooth, con gráfica de peso y dW/dt (flow).

## Características
- Conexión BLE (navegador) a la característica `1bc50002-0200-0aa5-e311-24cb004a98c5`.
- Decodifica `int32 little-endian` en **miligramos** → gramos.
- Tare por software (baseline en Start + botón extra de Tare).
- Gráfica en vivo y exportación a CSV.

## Requisitos
- Chrome/Edge en HTTPS (Vercel) con Bluetooth activado.
- Tu balanza visible como "MOTIF SCALE".

## Desarrollo
```bash
npm i
npm run dev
```

## Build y Deploy (Vercel)
- Sube este repo a GitHub.
- En Vercel: New Project → Importar repo → Framework: **Vite** (auto) → Build: `npm run build` → Output: `dist/`.
