# Sim Studio

Open source AI Agent framework.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/)
- [Docker](https://www.docker.com/) & Docker Compose

### Setup

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/simstudioai/sim.git
    cd sim
    ```

2.  **Install dependencies:**

    ```bash
    bun install
    ```

3.  **Environment Setup:**

    Copy the example environment file:

    ```bash
    cd apps/sim
    cp .env.example .env
    ```

    Update `.env` with necessary keys (OpenAI, Anthropic, etc.).
    For local development with Docker, `DATABASE_URL` is set automatically in `docker-compose.local.yml`, but for running locally without docker-compose for the app, you might need:
    `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/simstudio"`

4.  **Start Development Environment:**

    The easiest way to start is using Docker Compose, which spins up Postgres (with pgvector), Temporal, and the Worker.

    ```bash
    docker compose -f docker-compose.local.yml up -d
    ```

    This starts:
    - Postgres DB (Port 5432)
    - Temporal Server (Port 7233)
    - Temporal UI (Port 8080)
    - Sim Studio App (Port 3000)
    - Realtime Server (Port 3002)
    - Worker (Background processing)

    Access the app at [http://localhost:3000](http://localhost:3000).
    Access Temporal UI at [http://localhost:8080](http://localhost:8080).

### Manual Development (Running App locally)

If you prefer to run the Next.js app on your host machine while keeping DB/Temporal in Docker:

1.  Start infrastructure:

    ```bash
    docker compose -f docker-compose.local.yml up -d db temporal temporal-ui
    ```

2.  Run migrations:

    ```bash
    cd apps/sim
    bun run db:migrate
    ```

3.  Start the App and Worker:

    ```bash
    # Root directory
    bun run dev
    ```

    You also need to run the worker in a separate terminal:

    ```bash
    cd apps/sim
    bun run worker.ts
    ```

    And the socket server:

    ```bash
    cd apps/sim
    bun run dev:sockets
    ```

## Architecture

- **Frontend/API**: Next.js (App Router)
- **Workflow Engine**: Temporal.io
- **AI Agents**: LangChain & LangGraph
- **Database**: PostgreSQL + pgvector
- **Realtime**: Socket.io

## Deployment

Use `docker-compose.prod.yml` for production-like deployment.

```bash
docker compose -f docker-compose.prod.yml up -d
```
