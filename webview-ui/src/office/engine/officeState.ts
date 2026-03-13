import {
  ALL_DONE_WALK_DELAY_SEC,
  AUTO_ON_FACING_DEPTH,
  AUTO_ON_SIDE_DEPTH,
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  CHARACTER_SITTING_OFFSET_PX,
  DISMISS_BUBBLE_FAST_FADE_SEC,
  HUE_SHIFT_MIN_DEG,
  HUE_SHIFT_RANGE_DEG,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC,
  PALETTE_COUNT,
  REPORTING_APPROACH_TILES,
  SOCIALIZE_APPROACH_TILES,
  SOCIALIZE_CHAT_CHANCE,
  SOCIALIZING_WANDER_PAUSE_MAX_SEC,
  SOCIALIZING_WANDER_PAUSE_MIN_SEC,
  TALK_BUBBLE_DURATION_SEC,
  WAITING_BUBBLE_DURATION_SEC,
} from '../../constants.js';
import { getCatalogEntry, getOnStateType } from '../layout/furnitureCatalog.js';
import {
  createDefaultLayout,
  getBlockedTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
} from '../layout/layoutSerializer.js';
import { findPath, getWalkableTiles, isWalkable } from '../layout/tileMap.js';
import { findApproachTile, findDoorwayTiles, findZoneByType } from '../layout/zoneUtils.js';
import type {
  Character,
  FurnitureInstance,
  OfficeLayout,
  PlacedFurniture,
  Seat,
  TileType as TileTypeVal,
  Zone,
} from '../types.js';
import {
  CharacterState,
  Direction,
  MATRIX_EFFECT_DURATION,
  SubagentPhase,
  TILE_SIZE,
  ZoneType,
} from '../types.js';
import { createCharacter, updateCharacter } from './characters.js';
import { matrixEffectSeeds } from './matrixEffect.js';

export class OfficeState {
  layout: OfficeLayout;
  tileMap: TileTypeVal[][];
  seats: Map<string, Seat>;
  blockedTiles: Set<string>;
  furniture: FurnitureInstance[];
  walkableTiles: Array<{ col: number; row: number }>;
  characters: Map<number, Character> = new Map();
  selectedAgentId: number | null = null;
  cameraFollowId: number | null = null;
  hoveredAgentId: number | null = null;
  hoveredTile: { col: number; row: number } | null = null;
  /** Maps "parentId:toolId" → sub-agent character ID (negative) */
  subagentIdMap: Map<string, number> = new Map();
  /** Reverse lookup: sub-agent character ID → parent info */
  subagentMeta: Map<number, { parentAgentId: number; parentToolId: string }> = new Map();
  /** Preferred seat for the first (CEO) agent */
  primarySeatId: string | null = null;
  private nextSubagentId = -1;
  /** Cached zones from layout */
  private zones: Zone[] = [];
  /** Pre-computed walkable tiles outside the CEO room (for sub-agent wandering) */
  private nonCeoWalkableTiles: Array<{ col: number; row: number }> = [];
  /** CEO room tile keys to temporarily block for sub-agent pathfinding */
  private ceoTileKeys: string[] = [];
  /** Countdown timer before main agent walks to doorway after all sub-agents done */
  private allDoneWalkTimer: Map<number, number> = new Map();

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout();
    this.tileMap = layoutToTileMap(this.layout);
    this.seats = layoutToSeats(this.layout.furniture);
    this.blockedTiles = getBlockedTiles(this.layout.furniture);
    this.furniture = layoutToFurnitureInstances(this.layout.furniture);
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
    this.primarySeatId = this.layout.primarySeatId ?? null;
    this.cacheZones();
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters.
   *  @param shift Optional pixel shift to apply when grid expands left/up */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    this.layout = layout;
    this.tileMap = layoutToTileMap(layout);
    this.seats = layoutToSeats(layout.furniture);
    this.blockedTiles = getBlockedTiles(layout.furniture);
    this.rebuildFurnitureInstances();
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
    this.primarySeatId = layout.primarySeatId ?? null;
    this.cacheZones();

    // Shift character positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const ch of this.characters.values()) {
        ch.tileCol += shift.col;
        ch.tileRow += shift.row;
        ch.x += shift.col * TILE_SIZE;
        ch.y += shift.row * TILE_SIZE;
        // Clear path since tile coords changed
        ch.path = [];
        ch.moveProgress = 0;
      }
    }

    // Reassign characters to new seats, preserving existing assignments when possible
    for (const seat of this.seats.values()) {
      seat.assigned = false;
    }

    // First pass: try to keep characters at their existing seats
    for (const ch of this.characters.values()) {
      if (ch.seatId && this.seats.has(ch.seatId)) {
        const seat = this.seats.get(ch.seatId)!;
        if (!seat.assigned) {
          seat.assigned = true;
          // Snap character to seat position
          ch.tileCol = seat.seatCol;
          ch.tileRow = seat.seatRow;
          const cx = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
          const cy = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
          ch.x = cx;
          ch.y = cy;
          ch.dir = seat.facingDir;
          continue;
        }
      }
      ch.seatId = null; // will be reassigned below
    }

    // Second pass: assign remaining characters to free seats
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue;
      const seatId = this.findFreeSeat();
      if (seatId) {
        this.seats.get(seatId)!.assigned = true;
        ch.seatId = seatId;
        const seat = this.seats.get(seatId)!;
        ch.tileCol = seat.seatCol;
        ch.tileRow = seat.seatRow;
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
        ch.dir = seat.facingDir;
      }
    }

    // Relocate any characters that ended up outside bounds or on non-walkable tiles
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue; // seated characters are fine
      if (
        ch.tileCol < 0 ||
        ch.tileCol >= layout.cols ||
        ch.tileRow < 0 ||
        ch.tileRow >= layout.rows
      ) {
        this.relocateCharacterToWalkable(ch);
      }
    }
  }

  /** Move a character to a random walkable tile */
  private relocateCharacterToWalkable(ch: Character): void {
    if (this.walkableTiles.length === 0) return;
    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.path = [];
    ch.moveProgress = 0;
  }

  getLayout(): OfficeLayout {
    return this.layout;
  }

  /** Get the blocked-tile key for a character's own seat, or null */
  private ownSeatKey(ch: Character): string | null {
    if (!ch.seatId) return null;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return null;
    return `${seat.seatCol},${seat.seatRow}`;
  }

  /** Temporarily unblock a character's own seat, run fn, then re-block */
  private withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T {
    const key = this.ownSeatKey(ch);
    if (key) this.blockedTiles.delete(key);
    const result = fn();
    if (key) this.blockedTiles.add(key);
    return result;
  }

  /**
   * Find a free seat. Prefers desk-adjacent seats.
   * If excludeCol/excludeRow/excludeRadius provided, deprioritizes seats in that area
   * (used by sub-agents to avoid the CEO's office area).
   */
  private findFreeSeat(
    excludeCol?: number,
    excludeRow?: number,
    excludeRadius?: number,
  ): string | null {
    const hasExclusion =
      excludeCol !== undefined && excludeRow !== undefined && excludeRadius !== undefined;

    // Tier 1: nearDesk AND outside exclusion zone
    // Tier 2: nearDesk (anywhere)
    // Tier 3: any seat
    let tier2: string | null = null;
    let tier3: string | null = null;
    for (const [uid, seat] of this.seats) {
      if (seat.assigned) continue;
      if (seat.nearDesk) {
        if (
          hasExclusion &&
          Math.abs(seat.seatCol - excludeCol) + Math.abs(seat.seatRow - excludeRow) <= excludeRadius
        ) {
          if (!tier2) tier2 = uid;
        } else {
          return uid; // Tier 1: nearDesk + outside exclusion
        }
      } else {
        if (!tier3) tier3 = uid;
      }
    }
    return tier2 ?? tier3;
  }

  /** Cache zone data from the current layout */
  private cacheZones(): void {
    this.zones = this.layout.zones ?? [];
    // Compute walkable tiles outside CEO room (for sub-agent wandering restriction)
    const ceoZone = findZoneByType(this.zones, ZoneType.CEO_ROOM);
    if (ceoZone) {
      this.nonCeoWalkableTiles = this.walkableTiles.filter(
        (t) =>
          t.col < ceoZone.minCol ||
          t.col > ceoZone.maxCol ||
          t.row < ceoZone.minRow ||
          t.row > ceoZone.maxRow,
      );
      // Cache CEO tile keys for pathfinding blocking
      this.ceoTileKeys = [];
      for (let r = ceoZone.minRow; r <= ceoZone.maxRow; r++) {
        for (let c = ceoZone.minCol; c <= ceoZone.maxCol; c++) {
          const key = `${c},${r}`;
          if (!this.blockedTiles.has(key)) {
            this.ceoTileKeys.push(key);
          }
        }
      }
    } else {
      this.nonCeoWalkableTiles = this.walkableTiles;
      this.ceoTileKeys = [];
    }
  }

  /**
   * Pick a diverse palette for a new agent based on currently active agents.
   * First 6 agents each get a unique skin (random order). Beyond 6, skins
   * repeat in balanced rounds with a random hue shift (≥45°).
   */
  private pickDiversePalette(): { palette: number; hueShift: number } {
    // Count how many non-sub-agents use each base palette (0-5)
    const counts = new Array(PALETTE_COUNT).fill(0) as number[];
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue;
      counts[ch.palette]++;
    }
    const minCount = Math.min(...counts);
    // Available = palettes at the minimum count (least used)
    const available: number[] = [];
    for (let i = 0; i < PALETTE_COUNT; i++) {
      if (counts[i] === minCount) available.push(i);
    }
    const palette = available[Math.floor(Math.random() * available.length)];
    // First round (minCount === 0): no hue shift. Subsequent rounds: random ≥45°.
    let hueShift = 0;
    if (minCount > 0) {
      hueShift = HUE_SHIFT_MIN_DEG + Math.floor(Math.random() * HUE_SHIFT_RANGE_DEG);
    }
    return { palette, hueShift };
  }

  addAgent(
    id: number,
    preferredPalette?: number,
    preferredHueShift?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    folderName?: string,
  ): void {
    if (this.characters.has(id)) return;

    let palette: number;
    let hueShift: number;
    if (preferredPalette !== undefined) {
      palette = preferredPalette;
      hueShift = preferredHueShift ?? 0;
    } else {
      const pick = this.pickDiversePalette();
      palette = pick.palette;
      hueShift = pick.hueShift;
    }

    // Try preferred seat first, then primary seat for first agent, then any free seat
    let seatId: string | null = null;
    if (preferredSeatId && this.seats.has(preferredSeatId)) {
      const seat = this.seats.get(preferredSeatId)!;
      if (!seat.assigned) {
        seatId = preferredSeatId;
      }
    }
    // If no preferred seat and this is the first non-sub-agent, try primary seat
    if (!seatId && this.primarySeatId && this.seats.has(this.primarySeatId)) {
      const hasOtherAgents = Array.from(this.characters.values()).some((ch) => !ch.isSubagent);
      if (!hasOtherAgents) {
        const seat = this.seats.get(this.primarySeatId)!;
        if (!seat.assigned) {
          seatId = this.primarySeatId;
        }
      }
    }
    if (!seatId) {
      seatId = this.findFreeSeat();
    }

    let ch: Character;
    if (seatId) {
      const seat = this.seats.get(seatId)!;
      seat.assigned = true;
      ch = createCharacter(id, palette, seatId, seat, hueShift);
    } else {
      // No seats — spawn at random walkable tile
      const spawn =
        this.walkableTiles.length > 0
          ? this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
          : { col: 1, row: 1 };
      ch = createCharacter(id, palette, null, null, hueShift);
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
      ch.tileCol = spawn.col;
      ch.tileRow = spawn.row;
    }

    if (folderName) {
      ch.folderName = folderName;
    }
    if (!skipSpawnEffect) {
      ch.matrixEffect = 'spawn';
      ch.matrixEffectTimer = 0;
      ch.matrixEffectSeeds = matrixEffectSeeds();
    }
    this.characters.set(id, ch);
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    if (ch.matrixEffect === 'despawn') return; // already despawning
    // Free seat and clear selection immediately
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId);
      if (seat) seat.assigned = false;
    }
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
    // Start despawn animation instead of immediate delete
    ch.matrixEffect = 'despawn';
    ch.matrixEffectTimer = 0;
    ch.matrixEffectSeeds = matrixEffectSeeds();
    ch.bubbleType = null;
  }

  /** Find seat uid at a given tile position, or null */
  getSeatAtTile(col: number, row: number): string | null {
    for (const [uid, seat] of this.seats) {
      if (seat.seatCol === col && seat.seatRow === row) return uid;
    }
    return null;
  }

  /** Reassign an agent from their current seat to a new seat */
  reassignSeat(agentId: number, seatId: string): void {
    const ch = this.characters.get(agentId);
    if (!ch) return;
    // Unassign old seat
    if (ch.seatId) {
      const old = this.seats.get(ch.seatId);
      if (old) old.assigned = false;
    }
    // Assign new seat
    const seat = this.seats.get(seatId);
    if (!seat || seat.assigned) return;
    seat.assigned = true;
    ch.seatId = seatId;
    // Pathfind to new seat (unblock own seat tile for this query)
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
    );
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else {
      // Already at seat or no path — sit down
      ch.state = CharacterState.TYPE;
      ch.dir = seat.facingDir;
      ch.frame = 0;
      ch.frameTimer = 0;
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
      }
    }
  }

  /** Send an agent back to their currently assigned seat */
  sendToSeat(agentId: number): void {
    const ch = this.characters.get(agentId);
    if (!ch || !ch.seatId) return;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return;
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
    );
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else {
      // Already at seat — sit down
      ch.state = CharacterState.TYPE;
      ch.dir = seat.facingDir;
      ch.frame = 0;
      ch.frameTimer = 0;
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
      }
    }
  }

  /** Walk an agent to an arbitrary walkable tile (right-click command) */
  walkToTile(agentId: number, col: number, row: number): boolean {
    const ch = this.characters.get(agentId);
    if (!ch || ch.isSubagent) return false;
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) {
      // Also allow walking to own seat tile (blocked for others but not self)
      const key = this.ownSeatKey(ch);
      if (!key || key !== `${col},${row}`) return false;
    }
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles),
    );
    if (path.length === 0) return false;
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  /** Create a sub-agent character with the parent's palette. Returns the sub-agent ID. */
  addSubagent(parentAgentId: number, parentToolId: string, hueShiftOverride?: number): number {
    const key = `${parentAgentId}:${parentToolId}`;
    if (this.subagentIdMap.has(key)) return this.subagentIdMap.get(key)!;

    const id = this.nextSubagentId--;
    const parentCh = this.characters.get(parentAgentId);
    const palette = parentCh ? parentCh.palette : 0;
    const hueShift =
      hueShiftOverride !== undefined ? hueShiftOverride : parentCh ? parentCh.hueShift : 0;

    // Collect all unassigned seats outside the CEO room, then pick randomly
    let bestSeatId: string | null = null;
    const ceoZone = findZoneByType(this.zones, ZoneType.CEO_ROOM);
    const nonCeoSeatIds: string[] = [];
    for (const [uid, seat] of this.seats) {
      if (seat.assigned) continue;
      if (
        ceoZone &&
        seat.seatCol >= ceoZone.minCol &&
        seat.seatCol <= ceoZone.maxCol &&
        seat.seatRow >= ceoZone.minRow &&
        seat.seatRow <= ceoZone.maxRow
      ) {
        continue; // skip CEO room seats
      }
      nonCeoSeatIds.push(uid);
    }
    if (nonCeoSeatIds.length > 0) {
      bestSeatId = nonCeoSeatIds[Math.floor(Math.random() * nonCeoSeatIds.length)];
    }

    // Fallback: any unassigned seat (if all non-CEO seats are taken)
    if (!bestSeatId) {
      const allFree: string[] = [];
      for (const [uid, seat] of this.seats) {
        if (!seat.assigned) allFree.push(uid);
      }
      if (allFree.length > 0) {
        bestSeatId = allFree[Math.floor(Math.random() * allFree.length)];
      }
    }

    let ch: Character;
    if (bestSeatId) {
      const seat = this.seats.get(bestSeatId)!;
      seat.assigned = true;
      ch = createCharacter(id, palette, bestSeatId, seat, hueShift);
    } else {
      // No seats — spawn at random non-CEO walkable tile
      const tiles =
        this.nonCeoWalkableTiles.length > 0 ? this.nonCeoWalkableTiles : this.walkableTiles;
      let spawn = { col: 1, row: 1 };
      if (tiles.length > 0) {
        spawn = tiles[Math.floor(Math.random() * tiles.length)];
      }
      ch = createCharacter(id, palette, null, null, hueShift);
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
      ch.tileCol = spawn.col;
      ch.tileRow = spawn.row;
    }
    ch.isSubagent = true;
    ch.parentAgentId = parentAgentId;
    ch.subagentPhase = SubagentPhase.WORKING;
    ch.matrixEffect = 'spawn';
    ch.matrixEffectTimer = 0;
    ch.matrixEffectSeeds = matrixEffectSeeds();
    this.characters.set(id, ch);

    this.subagentIdMap.set(key, id);
    this.subagentMeta.set(id, { parentAgentId, parentToolId });
    console.log(
      `[OfficeState] Added sub-agent ${id} (parent=${parentAgentId}, tool=${parentToolId}, seat=${bestSeatId})`,
    );
    return id;
  }

  /** Remove a specific sub-agent character and free its seat */
  removeSubagent(parentAgentId: number, parentToolId: string): void {
    const key = `${parentAgentId}:${parentToolId}`;
    const id = this.subagentIdMap.get(key);
    if (id === undefined) return;
    console.log(
      `[OfficeState] Removing sub-agent ${id} (parent=${parentAgentId}, tool=${parentToolId})`,
    );

    const ch = this.characters.get(id);
    if (ch) {
      if (ch.matrixEffect === 'despawn') {
        // Already despawning — just clean up maps
        this.subagentIdMap.delete(key);
        this.subagentMeta.delete(id);
        return;
      }
      if (ch.seatId) {
        const seat = this.seats.get(ch.seatId);
        if (seat) seat.assigned = false;
      }
      // Start despawn animation — keep character in map for rendering
      ch.matrixEffect = 'despawn';
      ch.matrixEffectTimer = 0;
      ch.matrixEffectSeeds = matrixEffectSeeds();
      ch.bubbleType = null;
    }
    // Clean up tracking maps immediately so keys don't collide
    this.subagentIdMap.delete(key);
    this.subagentMeta.delete(id);
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
  }

  /** Remove all sub-agents belonging to a parent agent */
  removeAllSubagents(parentAgentId: number): void {
    console.log(`[OfficeState] Removing all sub-agents for parent=${parentAgentId}`);
    const toRemove: string[] = [];
    for (const [key, id] of this.subagentIdMap) {
      const meta = this.subagentMeta.get(id);
      if (meta && meta.parentAgentId === parentAgentId) {
        const ch = this.characters.get(id);
        if (ch) {
          if (ch.matrixEffect === 'despawn') {
            // Already despawning — just clean up maps
            this.subagentMeta.delete(id);
            toRemove.push(key);
            continue;
          }
          if (ch.seatId) {
            const seat = this.seats.get(ch.seatId);
            if (seat) seat.assigned = false;
          }
          // Start despawn animation
          ch.matrixEffect = 'despawn';
          ch.matrixEffectTimer = 0;
          ch.matrixEffectSeeds = matrixEffectSeeds();
          ch.bubbleType = null;
        }
        this.subagentMeta.delete(id);
        if (this.selectedAgentId === id) this.selectedAgentId = null;
        if (this.cameraFollowId === id) this.cameraFollowId = null;
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      this.subagentIdMap.delete(key);
    }
  }

  /** Deactivate a specific sub-agent — triggers reporting phase if zones exist, else idle */
  deactivateSubagent(parentAgentId: number, parentToolId: string): void {
    const key = `${parentAgentId}:${parentToolId}`;
    const id = this.subagentIdMap.get(key);
    if (id === undefined) return;
    console.log(
      `[OfficeState] Deactivating sub-agent ${id} (parent=${parentAgentId}, tool=${parentToolId})`,
    );
    this.setAgentTool(id, null);

    const ch = this.characters.get(id);
    if (!ch) return;

    // Free the sub-agent's seat
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId);
      if (seat) seat.assigned = false;
      ch.seatId = null;
    }
    ch.isActive = false;

    // If zones exist, start reporting phase; otherwise fall back to idle
    const ceoZone = findZoneByType(this.zones, ZoneType.CEO_ROOM);
    const parentCh = this.characters.get(parentAgentId);

    if (ceoZone && parentCh) {
      ch.subagentPhase = SubagentPhase.REPORTING;
      ch.hasReported = false;
      ch.reportingTimer = 0;

      // Find approach tile near parent within CEO room
      const approachTile = findApproachTile(
        parentCh.tileCol,
        parentCh.tileRow,
        REPORTING_APPROACH_TILES,
        ceoZone,
        this.tileMap,
        this.blockedTiles,
      );

      if (approachTile) {
        ch.phaseTarget = approachTile;
        const path = findPath(
          ch.tileCol,
          ch.tileRow,
          approachTile.col,
          approachTile.row,
          this.tileMap,
          this.blockedTiles,
        );
        if (path.length > 0) {
          ch.path = path;
          ch.moveProgress = 0;
          ch.state = CharacterState.WALK;
          ch.frame = 0;
          ch.frameTimer = 0;
        } else {
          // Can't path — skip to socializing
          this.transitionToSocializing(ch);
        }
      } else {
        // No approach tile — skip to socializing
        this.transitionToSocializing(ch);
      }
    } else {
      // No zones — old behavior (idle wander)
      ch.seatTimer = -1;
      ch.path = [];
      ch.moveProgress = 0;
      this.rebuildFurnitureInstances();
    }
  }

  /** Deactivate all sub-agents of a parent — triggers reporting phase.
   *  Skips sub-agents still in WORKING phase (their subagentClear hasn't arrived yet). */
  deactivateAllSubagents(parentAgentId: number): void {
    // Collect tool IDs first to avoid iterating while modifying state
    const toolIds: string[] = [];
    for (const [, id] of this.subagentIdMap) {
      const meta = this.subagentMeta.get(id);
      if (meta && meta.parentAgentId === parentAgentId) {
        const ch = this.characters.get(id);
        if (ch && ch.subagentPhase === SubagentPhase.WORKING) continue;
        toolIds.push(meta.parentToolId);
      }
    }
    for (const toolId of toolIds) {
      this.deactivateSubagent(parentAgentId, toolId);
    }
  }

  /** Look up the sub-agent character ID for a given parent+toolId, or null */
  getSubagentId(parentAgentId: number, parentToolId: string): number | null {
    return this.subagentIdMap.get(`${parentAgentId}:${parentToolId}`) ?? null;
  }

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.isActive = active;
      if (!active) {
        // Sentinel -1: signals turn just ended, skip next seat rest timer.
        // Prevents the WALK handler from setting a 2-4 min rest on arrival.
        ch.seatTimer = -1;
        ch.path = [];
        ch.moveProgress = 0;
      }
      this.rebuildFurnitureInstances();
    }
  }

  /** Rebuild furniture instances with auto-state applied (active agents turn electronics ON) */
  private rebuildFurnitureInstances(): void {
    // Collect tiles where active agents face desks
    const autoOnTiles = new Set<string>();
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.seatId) continue;
      const seat = this.seats.get(ch.seatId);
      if (!seat) continue;
      // Find the desk tile(s) the agent faces from their seat
      const dCol =
        seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
      // Check tiles in the facing direction (desk could be 1-3 tiles deep)
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
        const tileCol = seat.seatCol + dCol * d;
        const tileRow = seat.seatRow + dRow * d;
        autoOnTiles.add(`${tileCol},${tileRow}`);
      }
      // Also check tiles to the sides of the facing direction (desks can be wide)
      for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
        const baseCol = seat.seatCol + dCol * d;
        const baseRow = seat.seatRow + dRow * d;
        if (dCol !== 0) {
          // Facing left/right: check tiles above and below
          autoOnTiles.add(`${baseCol},${baseRow - 1}`);
          autoOnTiles.add(`${baseCol},${baseRow + 1}`);
        } else {
          // Facing up/down: check tiles left and right
          autoOnTiles.add(`${baseCol - 1},${baseRow}`);
          autoOnTiles.add(`${baseCol + 1},${baseRow}`);
        }
      }
    }

    if (autoOnTiles.size === 0) {
      this.furniture = layoutToFurnitureInstances(this.layout.furniture);
      return;
    }

    // Build modified furniture list with auto-state applied
    const modifiedFurniture: PlacedFurniture[] = this.layout.furniture.map((item) => {
      const entry = getCatalogEntry(item.type);
      if (!entry) return item;
      // Check if any tile of this furniture overlaps an auto-on tile
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          if (autoOnTiles.has(`${item.col + dc},${item.row + dr}`)) {
            const onType = getOnStateType(item.type);
            if (onType !== item.type) {
              return { ...item, type: onType };
            }
            return item;
          }
        }
      }
      return item;
    });

    this.furniture = layoutToFurnitureInstances(modifiedFurniture);
  }

  setAgentTool(id: number, tool: string | null): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.currentTool = tool;
    }
  }

  showPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = 'permission';
      ch.bubbleTimer = 0;
    }
  }

  clearPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch && ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    }
  }

  showWaitingBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = 'waiting';
      ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
    }
  }

  showTalkBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = 'talk';
      ch.bubbleTimer = TALK_BUBBLE_DURATION_SEC;
    }
  }

  /** Dismiss bubble on click — permission: instant, waiting/talk: quick fade */
  dismissBubble(id: number): void {
    const ch = this.characters.get(id);
    if (!ch || !ch.bubbleType) return;
    if (ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    } else if (ch.bubbleType === 'waiting' || ch.bubbleType === 'talk') {
      // Trigger immediate fade (0.3s remaining)
      ch.bubbleTimer = Math.min(ch.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC);
    }
  }

  /** Transition a sub-agent from reporting to socializing (wander outside CEO room) */
  private transitionToSocializing(ch: Character): void {
    ch.subagentPhase = SubagentPhase.SOCIALIZING;
    ch.phaseTarget = null;
    ch.bubbleType = null;
    ch.bubbleTimer = 0;
    ch.socializeChatTarget = null;

    // Pick a random non-CEO tile to walk to (workspace or kitchen)
    const socializeTiles =
      this.nonCeoWalkableTiles.length > 0 ? this.nonCeoWalkableTiles : this.walkableTiles;
    if (socializeTiles.length > 0) {
      const target = socializeTiles[Math.floor(Math.random() * socializeTiles.length)];
      const path = findPath(
        ch.tileCol,
        ch.tileRow,
        target.col,
        target.row,
        this.tileMap,
        this.blockedTiles,
      );
      if (path.length > 0) {
        ch.path = path;
        ch.moveProgress = 0;
        ch.state = CharacterState.WALK;
        ch.frame = 0;
        ch.frameTimer = 0;
        return;
      }
    }

    // Can't path — just idle in place
    ch.state = CharacterState.IDLE;
    ch.frame = 0;
    ch.frameTimer = 0;
    ch.wanderTimer =
      SOCIALIZING_WANDER_PAUSE_MIN_SEC +
      Math.random() * (SOCIALIZING_WANDER_PAUSE_MAX_SEC - SOCIALIZING_WANDER_PAUSE_MIN_SEC);
  }

  /** Check if all sub-agents of a parent are in socializing phase */
  private checkAllSubagentsDone(parentId: number): boolean {
    for (const [, id] of this.subagentIdMap) {
      const meta = this.subagentMeta.get(id);
      if (meta && meta.parentAgentId === parentId) {
        const ch = this.characters.get(id);
        if (!ch) continue;
        if (ch.matrixEffect === 'despawn') continue; // already despawning, skip
        if (ch.subagentPhase !== SubagentPhase.SOCIALIZING) return false;
      }
    }
    return true;
  }

  /** Walk main agent to the CEO room doorway */
  private mainAgentWalkToDoorway(parentId: number): void {
    const parentCh = this.characters.get(parentId);
    if (!parentCh) return;

    const ceoZone = findZoneByType(this.zones, ZoneType.CEO_ROOM);
    if (!ceoZone) return;

    const doorways = findDoorwayTiles(
      ceoZone,
      this.tileMap,
      this.blockedTiles,
      parentCh.tileCol,
      parentCh.tileRow,
    );
    if (doorways.length === 0) return;

    const target = doorways[0]; // closest doorway
    const path = this.withOwnSeatUnblocked(parentCh, () =>
      findPath(
        parentCh.tileCol,
        parentCh.tileRow,
        target.col,
        target.row,
        this.tileMap,
        this.blockedTiles,
      ),
    );
    if (path.length > 0) {
      parentCh.path = path;
      parentCh.moveProgress = 0;
      parentCh.state = CharacterState.WALK;
      parentCh.frame = 0;
      parentCh.frameTimer = 0;
    }
  }

  /** Face one character toward another */
  private faceToward(ch: Character, target: Character): void {
    const dc = target.tileCol - ch.tileCol;
    const dr = target.tileRow - ch.tileRow;
    if (Math.abs(dc) >= Math.abs(dr)) {
      ch.dir = dc >= 0 ? Direction.RIGHT : Direction.LEFT;
    } else {
      ch.dir = dr >= 0 ? Direction.DOWN : Direction.UP;
    }
  }

  update(dt: number): void {
    const toDelete: number[] = [];
    for (const ch of this.characters.values()) {
      // Handle matrix effect animation
      if (ch.matrixEffect) {
        ch.matrixEffectTimer += dt;
        if (ch.matrixEffectTimer >= MATRIX_EFFECT_DURATION) {
          if (ch.matrixEffect === 'spawn') {
            // Spawn complete — clear effect, resume normal FSM
            ch.matrixEffect = null;
            ch.matrixEffectTimer = 0;
            ch.matrixEffectSeeds = [];
          } else {
            // Despawn complete — mark for deletion
            toDelete.push(ch.id);
          }
        }
        continue; // skip normal FSM while effect is active
      }

      // Sub-agent reporting phase logic (before normal FSM)
      if (ch.isSubagent && ch.subagentPhase === SubagentPhase.REPORTING) {
        // Check if sub-agent has arrived at approach tile (path empty, not walking)
        if (ch.path.length === 0 && ch.state !== CharacterState.WALK && !ch.hasReported) {
          ch.hasReported = true;
          ch.reportingTimer = TALK_BUBBLE_DURATION_SEC;
          // Show talk bubbles on both sub-agent and parent
          this.showTalkBubble(ch.id);
          if (ch.parentAgentId !== null) {
            this.showTalkBubble(ch.parentAgentId);
            // Face sub-agent toward parent
            const parentCh = this.characters.get(ch.parentAgentId);
            if (parentCh) {
              this.faceToward(ch, parentCh);
            }
          }
          ch.state = CharacterState.IDLE;
          ch.frame = 0;
          ch.frameTimer = 0;
        }
        // Tick reporting timer
        if (ch.hasReported) {
          ch.reportingTimer -= dt;
          if (ch.reportingTimer <= 0) {
            // Reporting done — transition to socializing
            this.transitionToSocializing(ch);
            // Check if all sub-agents are now done
            if (ch.parentAgentId !== null && this.checkAllSubagentsDone(ch.parentAgentId)) {
              // Start delayed doorway walk for parent
              if (!this.allDoneWalkTimer.has(ch.parentAgentId)) {
                this.allDoneWalkTimer.set(ch.parentAgentId, ALL_DONE_WALK_DELAY_SEC);
                this.showWaitingBubble(ch.parentAgentId);
              }
            }
          }
        }
      }

      // Choose walkable tiles: all sub-agents stay outside CEO room
      const wanderTiles =
        ch.isSubagent && this.nonCeoWalkableTiles.length > 0
          ? this.nonCeoWalkableTiles
          : this.walkableTiles;

      // Block CEO room tiles for sub-agent pathfinding (except during reporting)
      const blockCeo =
        ch.isSubagent &&
        ch.subagentPhase !== SubagentPhase.REPORTING &&
        this.ceoTileKeys.length > 0;
      if (blockCeo) {
        for (const key of this.ceoTileKeys) this.blockedTiles.add(key);
      }

      // Sub-agent socialization: check arrival at chat target + intercept wander for chatting
      if (ch.isSubagent && ch.subagentPhase === SubagentPhase.SOCIALIZING) {
        // Check if arrived at chat target
        if (
          ch.socializeChatTarget !== null &&
          ch.path.length === 0 &&
          ch.state !== CharacterState.WALK
        ) {
          const chatTarget = this.characters.get(ch.socializeChatTarget);
          if (chatTarget) {
            const dist =
              Math.abs(ch.tileCol - chatTarget.tileCol) + Math.abs(ch.tileRow - chatTarget.tileRow);
            if (dist <= SOCIALIZE_APPROACH_TILES) {
              this.showTalkBubble(ch.id);
              this.showTalkBubble(ch.socializeChatTarget);
              this.faceToward(ch, chatTarget);
              this.faceToward(chatTarget, ch);
            }
          }
          ch.socializeChatTarget = null;
        }

        // Intercept wander timer: sometimes walk toward another socializing sub-agent
        if (
          ch.state === CharacterState.IDLE &&
          ch.path.length === 0 &&
          ch.socializeChatTarget === null &&
          ch.wanderTimer > 0 &&
          ch.wanderTimer <= dt
        ) {
          if (Math.random() < SOCIALIZE_CHAT_CHANCE) {
            const others = [...this.characters.values()].filter(
              (other) =>
                other.id !== ch.id &&
                other.isSubagent &&
                other.subagentPhase === SubagentPhase.SOCIALIZING &&
                other.matrixEffect === null,
            );
            if (others.length > 0) {
              const target = others[Math.floor(Math.random() * others.length)];
              // Find walkable tile adjacent to target
              const adjTiles: Array<{ col: number; row: number }> = [];
              for (let dc = -SOCIALIZE_APPROACH_TILES; dc <= SOCIALIZE_APPROACH_TILES; dc++) {
                for (let dr = -SOCIALIZE_APPROACH_TILES; dr <= SOCIALIZE_APPROACH_TILES; dr++) {
                  if (dc === 0 && dr === 0) continue;
                  if (Math.abs(dc) + Math.abs(dr) > SOCIALIZE_APPROACH_TILES) continue;
                  const tc = target.tileCol + dc;
                  const tr = target.tileRow + dr;
                  if (isWalkable(tc, tr, this.tileMap, this.blockedTiles)) {
                    adjTiles.push({ col: tc, row: tr });
                  }
                }
              }
              if (adjTiles.length > 0) {
                const dest = adjTiles[Math.floor(Math.random() * adjTiles.length)];
                const path = findPath(
                  ch.tileCol,
                  ch.tileRow,
                  dest.col,
                  dest.row,
                  this.tileMap,
                  this.blockedTiles,
                );
                if (path.length > 0) {
                  ch.path = path;
                  ch.moveProgress = 0;
                  ch.state = CharacterState.WALK;
                  ch.frame = 0;
                  ch.frameTimer = 0;
                  ch.wanderCount++;
                  ch.wanderTimer =
                    SOCIALIZING_WANDER_PAUSE_MIN_SEC +
                    Math.random() *
                      (SOCIALIZING_WANDER_PAUSE_MAX_SEC - SOCIALIZING_WANDER_PAUSE_MIN_SEC);
                  ch.socializeChatTarget = target.id;
                }
              }
            }
          }
        }
      }

      // Temporarily unblock own seat so character can pathfind to it
      this.withOwnSeatUnblocked(ch, () =>
        updateCharacter(ch, dt, wanderTiles, this.seats, this.tileMap, this.blockedTiles),
      );

      if (blockCeo) {
        for (const key of this.ceoTileKeys) this.blockedTiles.delete(key);
      }

      // Tick bubble timer for waiting and talk bubbles
      if (ch.bubbleType === 'waiting' || ch.bubbleType === 'talk') {
        ch.bubbleTimer -= dt;
        if (ch.bubbleTimer <= 0) {
          ch.bubbleType = null;
          ch.bubbleTimer = 0;
        }
      }
    }

    // Tick allDoneWalkTimer for parents
    for (const [parentId, timer] of this.allDoneWalkTimer) {
      const remaining = timer - dt;
      if (remaining <= 0) {
        this.allDoneWalkTimer.delete(parentId);
        this.mainAgentWalkToDoorway(parentId);
      } else {
        this.allDoneWalkTimer.set(parentId, remaining);
      }
    }

    // Remove characters that finished despawn
    for (const id of toDelete) {
      this.characters.delete(id);
    }
  }

  getCharacters(): Character[] {
    return Array.from(this.characters.values());
  }

  /** Get character at pixel position (for hit testing). Returns id or null. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = this.getCharacters().sort((a, b) => b.y - a.y);
    for (const ch of chars) {
      // Skip characters that are despawning
      if (ch.matrixEffect === 'despawn') continue;
      // Character sprite is 16x24, anchored bottom-center
      // Apply sitting offset to match visual position
      const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      const anchorY = ch.y + sittingOffset;
      const left = ch.x - CHARACTER_HIT_HALF_WIDTH;
      const right = ch.x + CHARACTER_HIT_HALF_WIDTH;
      const top = anchorY - CHARACTER_HIT_HEIGHT;
      const bottom = anchorY;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id;
      }
    }
    return null;
  }
}
