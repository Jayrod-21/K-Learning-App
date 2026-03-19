# 한국어 마스터 (Hangugeo Master)

> Personal Korean Learning Platform | TOPIK I & II Prep | Business & Fluency Focused

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + TypeScript |
| Backend | Node.js + Express |
| Database | Supabase (PostgreSQL + Auth) |
| AI | Claude API (claude-sonnet-4-6) |
| TTS | Web Speech API |
| SRS | Custom SM-2 algorithm |
| Styling | Tailwind CSS + Korean design tokens |

## Getting Started

### Prerequisites
- Node.js 18+
- Supabase project (free tier works)
- Anthropic API key

### Setup

1. Clone and install:
```bash
cd client && npm install
cd ../server && npm install
```

2. Configure environment variables:
```bash
cp client/.env.example client/.env
cp server/.env.example server/.env
# Edit both .env files with your credentials
```

3. Run the Supabase schema:
```bash
# Execute supabase/schema.sql in your Supabase SQL editor
```

4. Start development servers:
```bash
# Terminal 1 — Client
cd client && npm run dev

# Terminal 2 — Server
cd server && npm run dev
```

Client runs on `http://localhost:5173`, server on `http://localhost:3001`.

## Project Structure

```
├── client/               # React + Vite frontend
│   └── src/
│       ├── components/   # Reusable UI components
│       ├── pages/        # Route-level pages
│       ├── services/     # API + Supabase clients
│       ├── utils/        # SM-2 algorithm, helpers
│       ├── hooks/        # Custom React hooks
│       ├── types/        # TypeScript definitions
│       └── styles/       # Global CSS + design tokens
├── server/               # Node.js + Express backend
│   └── src/
│       ├── routes/       # API route definitions
│       ├── controllers/  # Route logic
│       ├── middleware/   # Auth middleware
│       └── services/     # Supabase + Claude services
└── supabase/
    └── schema.sql        # Database schema
```

## Current Phase

**Phase 1: Project Scaffold** — Complete
