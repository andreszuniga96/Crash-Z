<div align="center">

# ☣ ZombieRun Crash

**El juego de crash multijugador con zombis. Provably Fair, tiempo real, adrenalina pura.**

![ZombieRun Crash](https://img.shields.io/badge/status-production%20ready-22c55e?style=for-the-badge&logo=vercel)
![Stack](https://img.shields.io/badge/stack-React%20%7C%20Node.js%20%7C%20Three.js-ff6a1f?style=for-the-badge)
![Language](https://img.shields.io/badge/lang-TypeScript-3178c6?style=for-the-badge&logo=typescript)
![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)

</div>

---

## Que es ZombieRun Crash?

ZombieRun Crash es un juego de crash multijugador en tiempo real, ambientado en el apocalipsis zombie. Los jugadores apuestan en pesos colombianos (COP) y deben retirar **antes** de que el multiplicador colapse. Mientras mas esperas, mas ganas — pero si el zombie te alcanza, pierdes todo.

- **Tiempo real** via Socket.IO — todos los jugadores ven el mismo multiplicador
- **Provably Fair** — cada ronda es verificable con HMAC-SHA256
- **Montos accesibles** — desde $100 COP hasta $10.000 COP por apuesta
- **Sin tecnicismos** — registro simple, recarga via Nequi/Daviplata/Llave

---

## Capturas

> El juego presenta un motor 3D con Three.js WebGPU, HUD reactivo y animaciones en tiempo real.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│  CLIENTE (Vite + React + Three.js WebGPU)               │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  GameOverlay│  │ BettingPanel │  │  LiveMultiplier│  │
│  │  (HUD/UI)   │  │  (Apuestas)  │  │  (Multiplicador│  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  ZombieRunEngine (Three.js 3D Canvas)               │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Zustand Store ↔ Socket.IO Client                   │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                          │  WebSocket + REST
┌─────────────────────────────────────────────────────────┐
│  SERVIDOR (Node.js + Express + Socket.IO)               │
│  ┌──────────────┐  ┌────────────┐  ┌──────────────────┐ │
│  │GameStateMachine│ │ AuthRouter │  │  AdminRouter     │ │
│  │(BETTING→RUNNING│ │ JWT + bcrypt│  │  Balance/Users   │ │
│  │→CRASHED)       │ └────────────┘  └──────────────────┘ │
│  └──────────────┘                                       │
│  ┌──────────────┐  ┌────────────────────────────────┐  │
│  │  GameRouter  │  │  Provably Fair (HMAC-SHA256)    │  │
│  │  History/Bets│  │  Crash determinista y auditable  │  │
│  └──────────────┘  └────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                          │
           ┌──────────────┴──────────────┐
           │  MongoDB 7 (Replica Set)     │
           │  Redis 7 (Idempotency/Rate)  │
           └─────────────────────────────┘
```

---

## Funcionalidades

### Para el Jugador
| Feature | Descripcion |
|---------|-------------|
| 🎮 Motor 3D | Canvas Three.js WebGPU con zombis animados en tiempo real |
| 💰 Apuestas en COP | Desde $100 hasta $10.000 por ronda |
| ⚡ Auto-cashout | Configura un multiplicador objetivo y retira automaticamente |
| 🏆 Historial | Ultimas 20 rondas con sus multiplicadores |
| 🔍 Provably Fair | Verifica matematicamente que cada ronda fue justa |
| 🎉 Celebracion de ganancias | Overlay animado con monto exacto ganado |
| 📊 Rachas calientes | Deteccion y aviso de rachas de multiplicadores altos |
| 💳 Recarga | Instrucciones de deposito via Nequi, Daviplata o Llave |
| 💸 Retiros | Solicitud de retiro con limite diario de $50.000 COP |

### Para el Operador
| Feature | Descripcion |
|---------|-------------|
| 👑 Panel Admin | Gestion de usuarios, balances y transacciones |
| 📈 Leaderboard | Ranking de jugadores por ganancia y multiplicador |
| 🔒 Autenticacion JWT | Access token (15m) + refresh token (7d) |
| ⚖️ House Edge | Configurable por variable de entorno (default 3%) |
| 🐳 Docker Compose | Stack completo con MongoDB, Redis y Nginx |

---

## Limites de Transacciones

| Operacion | Limite Diario | Metodos |
|-----------|--------------|---------|
| Recarga   | $10.000 COP  | Nequi, Daviplata, Llave |
| Retiro    | $50.000 COP  | Nequi, Daviplata, Llave |
| Apuesta Minima | $100 COP | — |
| Apuesta Maxima | $10.000 COP | — |

> Los limites bajos son intencionales — el juego esta disenado para ser accesible para cualquier persona.

---

## Stack Tecnico

**Frontend**
- React 18 + TypeScript
- Three.js WebGPU (canvas 3D)
- Zustand (estado global)
- Socket.IO Client
- Tailwind CSS v3
- Vite 5

**Backend**
- Node.js + Express 5
- Socket.IO 4 (WebSocket multijugador)
- MongoDB 7 + Mongoose (Replica Set para transacciones)
- Redis 7 (idempotencia, rate limiting, pub/sub)
- JWT (autenticacion)
- bcrypt (hashing de contrasenas)

**Infra**
- Docker + Docker Compose
- Nginx (reverse proxy, TLS, WebSocket upgrade)
- Vercel (frontend deployment)

---

## Inicio Rapido (Desarrollo Local)

### Requisitos

- Node.js 20+
- MongoDB 7 (local o Atlas)
- Redis 7 (local o Redis Cloud)
- Git

### 1. Clonar y configurar

```bash
git clone https://github.com/iazr-code/Crash-Z.git
cd Crash-Z

cp .env.example .env
# Edita .env con tus valores
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar variables de entorno

Edita `.env`:

```env
NODE_ENV=development
PORT=3001
MONGODB_URI=mongodb://localhost:27017/zombierun
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=
JWT_SECRET=genera-64-chars-hex-aqui
CORS_ORIGINS=http://localhost:5173
BOOTSTRAP_ADMIN_EMAIL=admin@tudominio.com
BOOTSTRAP_ADMIN_PASSWORD=tu-password-seguro
BOOTSTRAP_ADMIN_USERNAME=admin
```

Genera el JWT_SECRET:
```bash
node -e "require('crypto').randomBytes(64).toString('hex')"
```

### 4. Iniciar servidores

```bash
# Terminal 1: Backend
npm run dev:server

# Terminal 2: Frontend
npm run dev:client
```

Abre http://localhost:5173

---

## Despliegue con Docker

### Requisitos adicionales
- Docker Engine 24+
- Docker Compose v2

### Configurar secretos adicionales para Docker

Agrega a `.env`:
```env
MONGO_ROOT_PASSWORD=password-mongo-root-seguro
MONGO_APP_PASSWORD=password-app-mongo-seguro
REDIS_PASSWORD=password-redis-seguro
CORS_ORIGINS=https://tu-dominio-vercel.vercel.app
```

### Construir y levantar

```bash
# Generar keyfile para MongoDB Replica Set (solo primera vez)
openssl rand -base64 756 > docker/mongo/keyfile
chmod 400 docker/mongo/keyfile

# Build y arranque
docker compose build
docker compose up -d

# Verificar estado
docker compose ps
docker compose logs -f server
```

La aplicacion estara disponible en http://localhost

---

## Despliegue Frontend en Vercel

### Opcion A: Automatico via GitHub

1. Conecta el repositorio en [vercel.com](https://vercel.com)
2. En la configuracion del proyecto:
   - **Build Command**: `npm run build --prefix packages/client`
   - **Output Directory**: `packages/client/dist`
   - **Install Command**: `npm install`
3. Edita `vercel.json` y reemplaza `your-backend-url.railway.app` con la URL real de tu backend
4. Deploy!

### Opcion B: CLI

```bash
npm i -g vercel
vercel --prod
```

> **Nota**: El backend (Node.js + Socket.IO) **NO puede** correr en Vercel por el uso de WebSockets. Deployalo en Railway, Fly.io, Render, o tu propio VPS con Docker.

---

## Despliegue Backend (Railway recomendado)

1. Crea un nuevo proyecto en [Railway](https://railway.app)
2. Conecta este repositorio
3. Agrega los servicios: **MongoDB** y **Redis** desde el marketplace de Railway
4. Configura las variables de entorno del servidor
5. El `Dockerfile` en `docker/server/` es compatible con Railway

---

## Variables de Entorno — Referencia Completa

| Variable | Requerida | Default | Descripcion |
|----------|-----------|---------|-------------|
| `NODE_ENV` | Si | `development` | Entorno |
| `PORT` | No | `3001` | Puerto del servidor |
| `MONGODB_URI` | Si | — | URI de conexion MongoDB |
| `REDIS_URL` | Si | — | URL de Redis |
| `REDIS_PASSWORD` | No | — | Password de Redis |
| `JWT_SECRET` | Si | — | Secreto JWT (minimo 32 chars) |
| `JWT_ACCESS_TTL` | No | `15m` | Duracion token de acceso |
| `JWT_REFRESH_TTL` | No | `7d` | Duracion token de refresco |
| `CORS_ORIGINS` | Si | — | Origenes permitidos (CSV) |
| `BETTING_PHASE_MS` | No | `7000` | Duracion fase de apuestas (ms) |
| `INTER_ROUND_DELAY_MS` | No | `5000` | Pausa entre rondas (ms) |
| `HOUSE_EDGE_PERCENT` | No | `3` | Ventaja de la casa (%) |
| `BOOTSTRAP_ADMIN_EMAIL` | No | — | Email del primer admin |
| `BOOTSTRAP_ADMIN_PASSWORD` | No | — | Password del primer admin |
| `BOOTSTRAP_ADMIN_USERNAME` | No | `admin` | Username del primer admin |

---

## Provably Fair — Como Funciona

Cada ronda usa **HMAC-SHA256** para garantizar que el multiplicador de crash es matematicamente verificable y no puede ser manipulado:

1. **Antes** de la ronda, el servidor publica el **hash del server seed** (SHA-256)
2. El seed del cliente es generado por el jugador (aleatoriamente al registrarse)
3. Al **colapsar**, el servidor revela el server seed
4. Cualquier persona puede verificar: `HMAC-SHA256(serverSeed, clientSeed + ":" + nonce)` reproduce exactamente el multiplicador

El boton "Verificar Ronda" en el juego hace esta verificacion con el servidor en tiempo real.

---

## Estructura del Proyecto

```
Crash-Z/
├── packages/
│   ├── client/                  # Frontend (Vite + React)
│   │   ├── src/
│   │   │   ├── components/
│   │   │   │   ├── game/        # GameOverlay, BettingPanel, LiveMultiplier...
│   │   │   │   ├── auth/        # Login, Register
│   │   │   │   ├── admin/       # Panel de administracion
│   │   │   │   └── ui/          # Componentes reutilizables
│   │   │   ├── game/            # ZombieRunEngine (Three.js)
│   │   │   ├── lib/             # currency.ts, multiplierCurve.ts
│   │   │   ├── socket/          # SocketManager, useGameSocket
│   │   │   └── store/           # Zustand gameStore
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── tailwind.config.js
│   │
│   └── server/                  # Backend (Express + Socket.IO)
│       ├── src/
│       │   ├── api/             # game.router.ts, admin.router.ts, auth.router.ts
│       │   ├── auth/            # JWT middleware, bcrypt
│       │   ├── crypto/          # provablyFair.ts
│       │   ├── game/            # GameStateMachine, limits.ts, types.ts
│       │   ├── models/          # User.model.ts, GameRound.model.ts, Bet.model.ts
│       │   └── socket/          # Socket event handlers
│       └── tsconfig.json
│
├── docker/                      # Dockerfiles y configs de infra
│   ├── server/Dockerfile
│   ├── client/Dockerfile
│   ├── nginx/nginx.conf
│   └── mongo/bootstrap.sh
│
├── docker-compose.yml           # Stack completo de produccion
├── vercel.json                  # Configuracion de Vercel
├── .env.example                 # Plantilla de variables de entorno
└── README.md
```

---

## Seguridad

- Contrasenas hasheadas con **bcrypt** (cost factor 12)
- JWT con rotacion de tokens (access 15m + refresh 7d)
- Rate limiting en todos los endpoints REST
- **Idempotency keys** en apuestas y cashouts (proteccion doble-click)
- Transacciones MongoDB atomicas para movimientos de saldo
- Limites de deposito ($10.000/dia) y retiro ($50.000/dia)
- Headers de seguridad via Nginx: `X-Content-Type-Options`, `X-Frame-Options`, `HSTS`
- CORS estricto — solo origenes configurados

---

## Licencia

MIT © 2026 iazr-code

---

<div align="center">

**Hecho con ☣ en Colombia**

[Reportar Bug](https://github.com/iazr-code/Crash-Z/issues) · [Solicitar Feature](https://github.com/iazr-code/Crash-Z/issues)

</div>
