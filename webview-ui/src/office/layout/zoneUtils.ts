import type { Seat, TileType as TileTypeVal, Zone, ZoneType } from '../types.js';
import { isWalkable } from './tileMap.js';

/** Check if a tile position is within a zone's bounds */
export function isInZone(col: number, row: number, zone: Zone): boolean {
  return col >= zone.minCol && col <= zone.maxCol && row >= zone.minRow && row <= zone.maxRow;
}

/** Find the first zone of the given type */
export function findZoneByType(zones: Zone[], type: ZoneType): Zone | null {
  return zones.find((z) => z.type === type) ?? null;
}

/** Get all walkable tiles within a zone's bounds */
export function getZoneWalkableTiles(
  zone: Zone,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): Array<{ col: number; row: number }> {
  const tiles: Array<{ col: number; row: number }> = [];
  for (let r = zone.minRow; r <= zone.maxRow; r++) {
    for (let c = zone.minCol; c <= zone.maxCol; c++) {
      if (isWalkable(c, r, tileMap, blockedTiles)) {
        tiles.push({ col: c, row: r });
      }
    }
  }
  return tiles;
}

/** Get seat UIDs that are within a zone's bounds */
export function getSeatsInZone(seats: Map<string, Seat>, zone: Zone): string[] {
  const result: string[] = [];
  for (const [uid, seat] of seats) {
    if (isInZone(seat.seatCol, seat.seatRow, zone)) {
      result.push(uid);
    }
  }
  return result;
}

/**
 * Find walkable tiles on the boundary of a zone that have walkable neighbors
 * outside the zone (i.e. doorway tiles). Sorted by distance to ref point.
 */
export function findDoorwayTiles(
  zone: Zone,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  refCol?: number,
  refRow?: number,
): Array<{ col: number; row: number }> {
  const doorways: Array<{ col: number; row: number }> = [];
  const dirs = [
    { dc: 0, dr: -1 },
    { dc: 0, dr: 1 },
    { dc: -1, dr: 0 },
    { dc: 1, dr: 0 },
  ];

  for (let r = zone.minRow; r <= zone.maxRow; r++) {
    for (let c = zone.minCol; c <= zone.maxCol; c++) {
      if (!isWalkable(c, r, tileMap, blockedTiles)) continue;
      // Check if any neighbor is walkable AND outside the zone
      for (const d of dirs) {
        const nc = c + d.dc;
        const nr = r + d.dr;
        if (!isInZone(nc, nr, zone) && isWalkable(nc, nr, tileMap, blockedTiles)) {
          doorways.push({ col: c, row: r });
          break; // only add once
        }
      }
    }
  }

  // Sort by distance to ref point if provided
  if (refCol !== undefined && refRow !== undefined) {
    doorways.sort((a, b) => {
      const da = Math.abs(a.col - refCol) + Math.abs(a.row - refRow);
      const db = Math.abs(b.col - refCol) + Math.abs(b.row - refRow);
      return da - db;
    });
  }

  return doorways;
}

/**
 * Find a walkable tile near a target position, within a zone, within maxDist tiles.
 */
export function findApproachTile(
  targetCol: number,
  targetRow: number,
  maxDist: number,
  zone: Zone,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): { col: number; row: number } | null {
  let best: { col: number; row: number } | null = null;
  let bestDist = Infinity;

  for (let r = zone.minRow; r <= zone.maxRow; r++) {
    for (let c = zone.minCol; c <= zone.maxCol; c++) {
      if (!isWalkable(c, r, tileMap, blockedTiles)) continue;
      const d = Math.abs(c - targetCol) + Math.abs(r - targetRow);
      if (d <= maxDist && d < bestDist) {
        bestDist = d;
        best = { col: c, row: r };
      }
    }
  }

  return best;
}

/**
 * Find a walkable tile near a target position (zone-free version).
 * Searches the entire tileMap within maxDist Manhattan distance.
 */
export function findNearbyWalkableTile(
  targetCol: number,
  targetRow: number,
  maxDist: number,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): { col: number; row: number } | null {
  let best: { col: number; row: number } | null = null;
  let bestDist = Infinity;

  const rows = tileMap.length;
  const cols = rows > 0 ? tileMap[0].length : 0;
  const rMin = Math.max(0, targetRow - maxDist);
  const rMax = Math.min(rows - 1, targetRow + maxDist);
  const cMin = Math.max(0, targetCol - maxDist);
  const cMax = Math.min(cols - 1, targetCol + maxDist);

  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      if (!isWalkable(c, r, tileMap, blockedTiles)) continue;
      const d = Math.abs(c - targetCol) + Math.abs(r - targetRow);
      if (d > 0 && d <= maxDist && d < bestDist) {
        bestDist = d;
        best = { col: c, row: r };
      }
    }
  }

  return best;
}
