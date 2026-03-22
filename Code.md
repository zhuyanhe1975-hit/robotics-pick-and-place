# Robotics Pick and Place - Codebase Notes

This project is a browser-based pick-and-place sandbox built with React, Three.js, and MuJoCo WASM. A model service analyzes the current rendered scene and returns target detections that are projected back into 3D for robot execution.

## Main pieces

- `App.tsx`: top-level orchestration, UI state, model calls, detection history, and pickup actions.
- `MujocoSim.ts`: simulation loop and robot action sequencing.
- `RenderSystem.ts`: rendering, camera, overlays, and 2D-to-3D projection.
- `RobotLoader.ts`: loads robot and scene assets into the MuJoCo virtual filesystem.
- `services/model.ts`: model-service adapter for mission analysis and scene detection.
- `components/UnifiedSidebar.tsx`: lightweight task workflow UI.

## Runtime flow

1. User enters a task description.
2. The app captures the current canvas snapshot.
3. The model service returns JSON describing targets or task guidance.
4. 2D detections are projected into 3D points.
5. The robot executes pickup motions against those projected targets.

## UX direction

- Keep the workflow linear: task input, target detection, pickup execution.
- Keep provider-specific details out of the UI.
- Use the sidebar as the main workspace and keep overlays minimal.
