import type { BoardMountLayout, BoundsDefinition, ComponentDefinition, FormFactor, PartKind, SlotDefinition, Vec3 } from '../core/types';

const bounds = (min: Vec3, max: Vec3): BoundsDefinition => ({ min, max });

export interface BoardProfile {
  id: FormFactor;
  width: number;
  height: number;
  /** Lower-left PCB corner, in the case coordinate frame. */
  position: Vec3;
  standoffs: readonly Vec3[];
  socket: Vec3;
  dimmXs: readonly number[];
  dimmY: number;
  dimmZ: number;
  m2: Vec3;
  pcie: Vec3;
  /** Index into the case's fixed expansion cutouts; never inferred from PCIe geometry. */
  expansionSlot: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/** PCB dimensions follow the form-factor standards. Socket layouts are SKU metadata,
 * not part of ATX: these are the bundled board's calibrated/representative layouts. */
export const BOARD_PROFILES: Record<FormFactor, BoardProfile> = {
  ATX: {
    id: 'ATX', width: .244, height: .305, position: [-.175, .14, -.07],
    standoffs: [
      [.01651, .01016, 0], [.15494, .01016, 0], [.23749, .01016, 0],
      [.01651, .1651, 0], [.15494, .1651, 0], [.23749, .1651, 0],
      [.01651, .29464, 0], [.15494, .29464, 0], [.23749, .29464, 0],
    ],
    socket: [.14018, .20499, .0055], dimmXs: [.18956, .19935, .20745, .21725], dimmY: .20963, dimmZ: .0117,
    m2: [.060, .139, .008], pcie: [.095386, .116414, .0095], expansionSlot: 2,
  },
  mATX: {
    id: 'mATX', width: .244, height: .244, position: [-.175, .201, -.07],
    standoffs: [
      [.01651, .00635, 0], [.15494, .00635, 0], [.23749, .00635, 0],
      [.01651, .10414, 0], [.15494, .10414, 0], [.23749, .10414, 0],
      [.01651, .23368, 0], [.15494, .23368, 0], [.23749, .23368, 0],
    ],
    socket: [.115, .152, .006], dimmXs: [.176, .187, .198, .209], dimmY: .160, dimmZ: .004,
    m2: [.046, .105, .005], pcie: [.095386, .075734, .0095], expansionSlot: 1,
  },
  ITX: {
    id: 'ITX', width: .17, height: .17, position: [-.175, .275, -.07],
    standoffs: [[.00635, .00635, 0], [.16383, .00635, 0], [.00635, .16383, 0], [.16383, .16383, 0]],
    socket: [.078, .078, .006], dimmXs: [.135, .149], dimmY: .0975, dimmZ: .004,
    m2: [.046, .126, .005], pcie: [.095386, .022054, .0095], expansionSlot: 0,
  },
};

export const CASE_BOUNDS = bounds([-.23, 0, -.115], [.23, .48, .115]);
export const CASE_INTERIOR = bounds([-.219, .015, -.103], [.220, .468, .106]);
export const GPU_BRACKET_LOCAL: Vec3 = [-.131386, 0, 0];
export const GPU_BRACKET_CASE: Vec3 = [-.211, .256414, -.0605];
export const CASE_EXPANSION_SLOT_PITCH = .02032;
/** Physical case cutouts, in case-local meters, ordered top to bottom. These
 * positions are case metadata and deliberately do not depend on board geometry. */
export const CASE_EXPANSION_CUTOUTS: readonly Vec3[] = [
  [-.211, .297054, -.0605],
  [-.211, .276734, -.0605],
  [-.211, .256414, -.0605],
  [-.211, .236094, -.0605],
  [-.211, .215774, -.0605],
  [-.211, .195454, -.0605],
  [-.211, .175134, -.0605],
];
export const MOUNT_TOLERANCE = .0015;
export const CPU_IHS_HEIGHT = .0027067;
export const THERMAL_INTERFACE_GAP = .0002;

const definitions: Record<PartKind, ComponentDefinition> = {
  case: { kind: 'case', label: 'PC Case', watts: 0, bounds: CASE_BOUNDS, description: '460 × 480 × 230 mm chassis with ATX mounting tray' },
  motherboard: { kind: 'motherboard', label: 'Motherboard', watts: 55, bounds: bounds([0, 0, 0], [.244, .305, .0432]), collisionBounds: [bounds([0, 0, 0], [.244, .305, .0016])], description: 'Vertical PCB on case standoffs; all connectors are board-local' },
  cpu: { kind: 'cpu', label: 'Processor', watts: 125, bounds: bounds([-.02, -.02, 0], [.02, .02, CPU_IHS_HEIGHT]), description: '40 mm CPU package seated inside the socket frame' },
  cooler: { kind: 'cooler', label: 'CPU Cooler', watts: 8, bounds: bounds([-.034, -.034, 0], [.034, .034, .058]), description: 'Compact cooler mounted directly to the CPU IHS' },
  ram: { kind: 'ram', label: 'Memory', watts: 5, bounds: bounds([-.00375, -.0665, 0], [.00375, .0665, .043]), description: 'One 133 mm DIMM per socket; A2 + B2 recommended' },
  gpu: { kind: 'gpu', label: 'Graphics Card', watts: 285, bounds: bounds([-.131386, -.052, 0], [.168614, .008, .15]), description: '300 mm card with PCIe connector origin and a constrained rear I/O bracket' },
  psu: { kind: 'psu', label: 'Power Supply', watts: 0, bounds: bounds([0, 0, 0], [.16, .086, .15]), description: 'ATX supply seated inside the isolated lower shroud' },
  ssd: { kind: 'ssd', label: 'M.2 Storage', watts: 8, bounds: bounds([0, -.011, 0], [.08, .011, .006]), description: 'M.2 2280 board with connector-local origin' },
  fan: { kind: 'fan', label: 'Case Fan', watts: 4, bounds: bounds([-.06, -.06, 0], [.06, .06, .025]), description: '120 × 25 mm fan aligned to a 105 mm screw pattern' },
  radiator: { kind: 'radiator', label: '240 mm Radiator', watts: 0, bounds: bounds([-.137, -.06, 0], [.137, .06, .027]), description: '274 × 120 × 27 mm radiator on the top fan rails' },
};

export const PART_KINDS = Object.keys(definitions) as PartKind[];

export function getDefinition(kind: PartKind, formFactor: FormFactor = 'ATX'): ComponentDefinition {
  const definition = definitions[kind];
  if (kind !== 'motherboard') return definition;
  const board = BOARD_PROFILES[formFactor];
  return {
    ...definition,
    bounds: bounds([0, 0, 0], [formFactor === 'ATX' ? .245412 : board.width, board.height, .0432]),
    collisionBounds: [bounds([0, 0, 0], [board.width, board.height, formFactor === 'ATX' ? .0042 : .0016])],
    description: `${formFactor} · ${Math.round(board.width * 1000)} × ${Math.round(board.height * 1000)} mm PCB`,
  };
}

const fanScrews: readonly Vec3[] = [[-.0525, -.0525, 0], [-.0525, .0525, 0], [.0525, -.0525, 0], [.0525, .0525, 0]];

function slot(id: string, label: string, kind: PartKind, position: Vec3, volume: BoundsDefinition, options: Partial<SlotDefinition> = {}): SlotDefinition {
  return { id, label, accepts: [kind], position, bounds: volume, snapVector: [0, 0, 1], snapRadius: .065, ...options };
}

export function getSlotDefinitions(kind: PartKind, formFactor: FormFactor, boardMountLayout?: BoardMountLayout): SlotDefinition[] {
  const board = BOARD_PROFILES[formFactor];
  if (kind === 'case') {
    return [
      slot('case:motherboard', `${formFactor} standoffs`, 'motherboard', board.position, bounds([0, 0, -.003], [board.width, board.height, .009]), { screwPoints: board.standoffs }),
      slot('case:psu', 'PSU bay', 'psu', [-.215, .018, -.092], definitions.psu.bounds, { snapVector: [-1, 0, 0] }),
      ...[.165, .286, .407].map((y, i) => slot(`case:fan-front-${i + 1}`, `Front fan ${i + 1}`, 'fan', [.213, y, 0], definitions.fan.bounds, { rotation: [0, -Math.PI / 2, 0], screwPoints: fanScrews, priority: i + 2 })),
      slot('case:fan-rear', 'Rear exhaust', 'fan', [-.208, .378, .008], definitions.fan.bounds, { rotation: [0, Math.PI / 2, 0], screwPoints: fanScrews, priority: 1 }),
      ...[-.076, .052].map((x, i) => slot(`case:fan-top-${i + 1}`, `Top fan ${i + 1}`, 'fan', [x, .456, .035], definitions.fan.bounds, { rotation: [Math.PI / 2, 0, 0], screwPoints: fanScrews, priority: i + 5 })),
      slot('case:radiator-top', 'Top 240 mm radiator', 'radiator', [-.012, .459, .035], definitions.radiator.bounds, { rotation: [Math.PI / 2, 0, 0], screwPoints: fanScrews }),
      ...CASE_EXPANSION_CUTOUTS.map((position, index): SlotDefinition => ({ id: `case:expansion-slot-${index + 1}`, label: `Case expansion cutout ${index + 1}`, accepts: [], position, bounds: bounds([-.002, -.01016, 0], [.002, .01016, .15]), snapVector: [-1, 0, 0], snapRadius: .005 })),
      { id: 'case:gpu-bracket', label: `Rear PCIe bracket · cutout ${board.expansionSlot + 1}`, accepts: [], position: CASE_EXPANSION_CUTOUTS[board.expansionSlot], bounds: bounds([-.002, -.052, 0], [.002, .008, .15]), snapVector: [-1, 0, 0], snapRadius: .005 },
    ];
  }
  if (kind === 'motherboard') {
    const ramPriorities = board.dimmXs.length === 4 ? [3, 1, 4, 2] : [1, 2];
    const slots = [
      slot('motherboard:cpu', 'CPU socket', 'cpu', board.socket, bounds([-.024, -.024, -.002], [.024, .024, .009])),
      ...board.dimmXs.map((x, i) => slot(`motherboard:dimm${i + 1}`, `DIMM ${i + 1}${board.dimmXs.length === 4 ? [' · A1', ' · A2', ' · B1', ' · B2'][i] : ''}`, 'ram', [x, board.dimmY, board.dimmZ], definitions.ram.bounds, { priority: ramPriorities[i], snapRadius: .03 })),
      slot('motherboard:m2-1', 'M.2 2280', 'ssd', board.m2, definitions.ssd.bounds, { screwPoints: [[.075, 0, 0]], snapRadius: .038 }),
      slot('motherboard:pcie1', 'PCIe x16 · slot 1', 'gpu', board.pcie, bounds([-.006, -.004, -.003], [.092, .004, .009]), { snapRadius: .09 }),
    ];
    return slots.map(item => {
      const override = boardMountLayout?.[item.id as keyof BoardMountLayout];
      return override ? { ...item, position: [...override.position] as Vec3, rotation: override.rotation ? [...override.rotation] as Vec3 : item.rotation } : item;
    });
  }
  if (kind === 'cpu') return [slot('cpu:cooler', 'CPU heat spreader', 'cooler', [0, 0, CPU_IHS_HEIGHT + THERMAL_INTERFACE_GAP], definitions.cooler.bounds, { screwPoints: [[-.0375, -.0375, 0], [-.0375, .0375, 0], [.0375, -.0375, 0], [.0375, .0375, 0]] })];
  return [];
}

export interface ObstacleDefinition { id: string; label: string; bounds: BoundsDefinition; except?: readonly PartKind[] }

export function getObstacleDefinitions(kind: PartKind, formFactor: FormFactor): ObstacleDefinition[] {
  if (kind === 'case') return [
    { id: 'glass', label: 'glass panel', bounds: bounds([-.23, .015, .106], [.23, .48, .115]) },
    { id: 'backplate', label: 'back panel', bounds: bounds([-.23, .015, -.115], [.23, .48, -.103]) },
    { id: 'shroud', label: 'PSU shroud', bounds: bounds([-.219, .015, -.103], [.170, .112, .106]), except: ['psu'] },
    { id: 'roof', label: 'top frame', bounds: bounds([-.23, .468, -.115], [.23, .48, .115]) },
    { id: 'front', label: 'front frame', bounds: bounds([.220, .015, -.103], [.23, .468, .106]) },
    { id: 'rear', label: 'rear frame', bounds: bounds([-.23, .015, -.103], [-.219, .468, .106]) },
  ];
  if (kind === 'motherboard') {
    const board = BOARD_PROFILES[formFactor];
    return [
      { id: 'vrm-rear', label: 'rear VRM / I/O heatsink', bounds: bounds([.003, board.height - .132, .0016], [.043, board.height - .009, .029]) },
      { id: 'vrm-top', label: 'top VRM heatsink', bounds: bounds([.055, board.height - .030, .0016], [Math.min(.162, board.dimmXs[0] - .0175), board.height - .007, .020]) },
    ];
  }
  return [];
}
