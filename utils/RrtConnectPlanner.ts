import { PlanningTarget, TrajectoryTargetHint } from '../types';

type Point2D = { x: number; y: number };
type ObstacleCircle = { x: number; y: number; radius: number };

interface RrtNode {
  point: Point2D;
  parent: number | null;
}

const WORKSPACE_BOUNDS = {
  minX: 0.18,
  maxX: 0.62,
  minY: -0.3,
  maxY: 0.3,
};

const STEP_SIZE = 0.045;
const GOAL_THRESHOLD = 0.04;
const MAX_ITERATIONS = 400;
const SHORTCUT_ATTEMPTS = 80;
const OBSTACLE_MARGIN = 0.05;
const TRAY_POINT = { x: 0.6, y: 0 };
const HOME_POINT = { x: 0, y: 0 };

function distance(a: Point2D, b: Point2D) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function interpolate(a: Point2D, b: Point2D, t: number): Point2D {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function clampToBounds(point: Point2D): Point2D {
  return {
    x: Math.min(WORKSPACE_BOUNDS.maxX, Math.max(WORKSPACE_BOUNDS.minX, point.x)),
    y: Math.min(WORKSPACE_BOUNDS.maxY, Math.max(WORKSPACE_BOUNDS.minY, point.y)),
  };
}

function pointCollides(point: Point2D, obstacles: ObstacleCircle[]) {
  return obstacles.some((obstacle) => distance(point, obstacle) <= obstacle.radius);
}

function segmentCollides(start: Point2D, end: Point2D, obstacles: ObstacleCircle[]) {
  const samples = Math.max(2, Math.ceil(distance(start, end) / 0.01));
  for (let i = 0; i <= samples; i++) {
    const point = interpolate(start, end, i / samples);
    if (pointCollides(point, obstacles)) {
      return true;
    }
  }
  return false;
}

function sampleFreePoint(obstacles: ObstacleCircle[]): Point2D {
  for (let attempt = 0; attempt < 100; attempt++) {
    const point = {
      x: WORKSPACE_BOUNDS.minX + Math.random() * (WORKSPACE_BOUNDS.maxX - WORKSPACE_BOUNDS.minX),
      y: WORKSPACE_BOUNDS.minY + Math.random() * (WORKSPACE_BOUNDS.maxY - WORKSPACE_BOUNDS.minY),
    };
    if (!pointCollides(point, obstacles)) return point;
  }
  return { x: 0.4, y: 0 };
}

function nearestNodeIndex(tree: RrtNode[], point: Point2D) {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  tree.forEach((node, index) => {
    const d = distance(node.point, point);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function steer(from: Point2D, to: Point2D) {
  const d = distance(from, to);
  if (d <= STEP_SIZE) return clampToBounds(to);
  const ratio = STEP_SIZE / d;
  return clampToBounds({
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  });
}

function backtrack(tree: RrtNode[], fromIndex: number) {
  const points: Point2D[] = [];
  let index: number | null = fromIndex;
  while (index !== null) {
    points.push(tree[index].point);
    index = tree[index].parent;
  }
  return points.reverse();
}

function shortcutPath(path: Point2D[], obstacles: ObstacleCircle[]) {
  if (path.length <= 2) return path;
  const optimized = [...path];
  for (let attempt = 0; attempt < SHORTCUT_ATTEMPTS; attempt++) {
    const startIndex = Math.floor(Math.random() * Math.max(1, optimized.length - 2));
    const endIndex = startIndex + 2 + Math.floor(Math.random() * Math.max(1, optimized.length - startIndex - 2));
    if (endIndex >= optimized.length) continue;
    if (!segmentCollides(optimized[startIndex], optimized[endIndex], obstacles)) {
      optimized.splice(startIndex + 1, endIndex - startIndex - 1);
    }
  }
  return optimized;
}

function pathLength(path: Point2D[]) {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += distance(path[i - 1], path[i]);
  }
  return total;
}

function directOrPlannedPath(start: Point2D, goal: Point2D, obstacles: ObstacleCircle[]) {
  if (!segmentCollides(start, goal, obstacles)) {
    return [start, goal];
  }

  let treeA: RrtNode[] = [{ point: start, parent: null }];
  let treeB: RrtNode[] = [{ point: goal, parent: null }];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const randomPoint = sampleFreePoint(obstacles);
    const nearestA = nearestNodeIndex(treeA, randomPoint);
    const newPointA = steer(treeA[nearestA].point, randomPoint);
    if (segmentCollides(treeA[nearestA].point, newPointA, obstacles)) {
      [treeA, treeB] = [treeB, treeA];
      continue;
    }

    treeA.push({ point: newPointA, parent: nearestA });
    let connectIndex = nearestNodeIndex(treeB, newPointA);
    let connectPoint = treeB[connectIndex].point;

    while (!segmentCollides(connectPoint, newPointA, obstacles)) {
      const nextPoint = steer(connectPoint, newPointA);
      treeB.push({ point: nextPoint, parent: connectIndex });
      connectIndex = treeB.length - 1;
      connectPoint = nextPoint;
      if (distance(connectPoint, newPointA) <= GOAL_THRESHOLD) {
        const pathA = backtrack(treeA, treeA.length - 1);
        const pathB = backtrack(treeB, connectIndex).reverse();
        return shortcutPath([...pathA, ...pathB.slice(1)], obstacles);
      }
      if (distance(connectPoint, newPointA) < STEP_SIZE) break;
    }

    [treeA, treeB] = [treeB, treeA];
  }

  return [start, goal];
}

function buildObstacles(targets: PlanningTarget[], excludedLabels: string[]) {
  const excluded = new Set(excludedLabels);
  return targets
    .filter((target) => !excluded.has(target.label))
    .map((target) => ({
      x: target.x,
      y: target.y,
      radius: OBSTACLE_MARGIN,
    }));
}

export function buildTrajectoryHintsForOrder(targets: PlanningTarget[]): TrajectoryTargetHint[] {
  let previousDrop = HOME_POINT;

  return targets.map((target, index) => {
    const targetPoint = { x: target.x, y: target.y };
    const obstacles = buildObstacles(targets, [target.label]);
    const approachPath = directOrPlannedPath(previousDrop, targetPoint, obstacles);
    const transferPath = directOrPlannedPath(targetPoint, TRAY_POINT, obstacles);

    previousDrop = TRAY_POINT;

    return {
      targetIndex: index,
      targetLabel: target.label,
      approachPathLength: pathLength(approachPath),
      transferPathLength: pathLength(transferPath),
      approachWaypointCount: approachPath.length,
      transferWaypointCount: transferPath.length,
    };
  });
}
