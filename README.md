# Robotics Pick and Place

## Run Locally

Prerequisite: Node.js

1. Install dependencies:
   `npm install`
2. Fill in `NUWA_API_KEY` in [`.env.local`](/D:/AI/robotics-pick-and-place/.env.local)
3. Optional overrides:
   `NUWA_BASE_URL=https://api.nuwaflux.com/v1`
   `NUWA_MODEL=gemini-3-flash-preview`
4. Start the dev server:
   `npm run dev`

## Experiment Logs

When the app runs under the local Vite server, experiment events are appended to:
`logs/experiment-log.jsonl`

Each line is a JSON record for scene generation, execution plans, execution results, timeouts, and workflow errors.
